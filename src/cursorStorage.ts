import * as vscode from "vscode";

export type StorageCandidate = {
  uri: vscode.Uri;
  reason: string;
};

const TEXT_KEYS = ["messages", "message", "conversation", "chat", "composer", "prompt", "completion", "assistant", "user"];

function looksInterestingFile(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return true;
  if (lower.endsWith(".jsonl")) return true;
  if (lower.endsWith(".txt")) return true;
  if (lower.endsWith(".md")) return true;
  return false;
}

async function* walk(dir: vscode.Uri, maxDepth: number): AsyncGenerator<vscode.Uri> {
  const stack: Array<{ uri: vscode.Uri; depth: number }> = [{ uri: dir, depth: 0 }];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(cur.uri);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(cur.uri, name);
      if (type === vscode.FileType.Directory) {
        if (cur.depth < maxDepth) stack.push({ uri: child, depth: cur.depth + 1 });
        continue;
      }
      yield child;
    }
  }
}

function extractTextFromJsonish(obj: unknown, maxChars: number): string {
  const out: string[] = [];
  const seen = new Set<unknown>();

  const push = (s: unknown) => {
    if (typeof s !== "string") return;
    const t = s.trim();
    if (!t) return;
    out.push(t);
  };

  const visit = (v: unknown) => {
    if (!v) return;
    if (typeof v === "string") {
      push(v);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const it of v) visit(it);
      return;
    }
    const rec = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(rec)) {
      const key = k.toLowerCase();
      if (TEXT_KEYS.some((t) => key.includes(t))) visit(val);
      else if (typeof val === "object") visit(val);
    }
  };

  visit(obj);
  const joined = out.join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

export async function findStorageCandidates(root: vscode.Uri, maxDepth = 4, maxFiles = 1500): Promise<StorageCandidate[]> {
  const candidates: StorageCandidate[] = [];
  let count = 0;
  for await (const uri of walk(root, maxDepth)) {
    if (++count > maxFiles) break;
    const name = uri.path.split("/").pop() ?? "";
    if (!looksInterestingFile(name)) continue;
    candidates.push({ uri, reason: "extension/filename match" });
  }
  return candidates;
}

export async function extractConversationText(uri: vscode.Uri, maxBytes = 2_000_000): Promise<string | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
  if (bytes.byteLength > maxBytes) return undefined;
  const raw = Buffer.from(bytes).toString("utf8");

  const lower = raw.toLowerCase();
  if (!TEXT_KEYS.some((k) => lower.includes(k))) return undefined;

  const name = uri.path.toLowerCase();
  if (name.endsWith(".json")) {
    try {
      const obj = JSON.parse(raw) as unknown;
      const txt = extractTextFromJsonish(obj, 200_000);
      return txt.trim().length ? txt : undefined;
    } catch {
      return undefined;
    }
  }

  // jsonl/txt/md: best-effort raw
  return raw.trim().length ? raw.slice(-200_000) : undefined;
}

