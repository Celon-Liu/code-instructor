import * as vscode from "vscode";

export type RunCommandResult =
  | { ok: true; durationMs: number; stdout: string; stderr: string }
  | { ok: false; durationMs: number; stdout: string; stderr: string; exitCode: number };

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type CommandSource = "configured" | "inferred" | "default";
export type ResolvedCommand = {
  command: string;
  source: CommandSource;
  scriptName?: string;
  packageManager?: PackageManager;
};

function tailText(s: string, maxChars: number) {
  if (s.length <= maxChars) return s;
  return s.slice(-maxChars);
}

async function tryReadFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch {
    return undefined;
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function formatRunCommand(pm: PackageManager, scriptName: string): string {
  if (pm === "yarn") return `yarn ${scriptName}`;
  if (pm === "bun") return `bun run ${scriptName}`;
  if (pm === "pnpm") return `pnpm run ${scriptName}`;
  return `npm run ${scriptName}`;
}

async function detectPackageManager(baseDir: string): Promise<PackageManager> {
  const root = vscode.Uri.file(baseDir);
  if (await fileExists(vscode.Uri.joinPath(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(vscode.Uri.joinPath(root, "yarn.lock"))) return "yarn";
  if (await fileExists(vscode.Uri.joinPath(root, "bun.lockb"))) return "bun";
  return "npm";
}

async function inferScriptCommand(
  cwd: string | undefined,
  scriptCandidates: string[]
): Promise<{ command: string; scriptName: string; packageManager: PackageManager } | undefined> {
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const baseDir = cwd && cwd.trim().length > 0 ? cwd : wsFolder?.uri.fsPath;
  if (!baseDir) return undefined;

  const pkgUri = vscode.Uri.file(`${baseDir}/package.json`);
  const raw = await tryReadFile(pkgUri);
  if (!raw) return undefined;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const matched = scriptCandidates.find((x) => Boolean(scripts[x]));
    if (!matched) return undefined;
    const pm = await detectPackageManager(baseDir);
    return { command: formatRunCommand(pm, matched), scriptName: matched, packageManager: pm };
  } catch {
    return undefined;
  }
}

export async function resolveBuildCommand(configured: string | undefined, cwd: string | undefined): Promise<ResolvedCommand> {
  const explicit = (configured || "").trim();
  if (explicit) return { command: explicit, source: "configured" };

  const inferred = await inferScriptCommand(cwd, ["build", "compile", "typecheck", "check"]);
  if (inferred) {
    return {
      command: inferred.command,
      source: "inferred",
      scriptName: inferred.scriptName,
      packageManager: inferred.packageManager
    };
  }

  return { command: "npm run build", source: "default" };
}

export async function resolveTestCommand(
  configured: string | undefined,
  cwd: string | undefined
): Promise<ResolvedCommand | undefined> {
  const explicit = (configured || "").trim();
  if (explicit) return { command: explicit, source: "configured" };

  const inferred = await inferScriptCommand(cwd, ["test:ci", "test", "test:unit", "unit"]);
  if (!inferred) return undefined;
  return {
    command: inferred.command,
    source: "inferred",
    scriptName: inferred.scriptName,
    packageManager: inferred.packageManager
  };
}

export async function runCommand(command: string, cwd: string | undefined, timeoutMs: number): Promise<RunCommandResult> {
  const start = Date.now();
  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  const resolvedCwd = cwd && cwd.trim().length > 0 ? cwd : wsFolder?.uri.fsPath;

  const exec = require("child_process").exec as (
    cmd: string,
    opts: { cwd?: string; timeout?: number; maxBuffer?: number },
    cb: (err: unknown, stdout: string, stderr: string) => void
  ) => { unref?: () => void };

  const r = await new Promise<RunCommandResult>((resolve) => {
    const child = exec(
      command,
      { cwd: resolvedCwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err: unknown, stdout: string, stderr: string) => {
        const durationMs = Date.now() - start;
        if (!err) {
          resolve({ ok: true, durationMs, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        const anyErr = err as { code?: number };
        resolve({
          ok: false,
          durationMs,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof anyErr?.code === "number" ? anyErr.code : 1
        });
      }
    );
    child.unref?.();
  });

  if (r.ok) {
    return {
      ok: true,
      durationMs: r.durationMs,
      stdout: tailText(r.stdout, 8000),
      stderr: tailText(r.stderr, 8000)
    };
  }
  return {
    ok: false,
    durationMs: r.durationMs,
    stdout: tailText(r.stdout, 8000),
    stderr: tailText(r.stderr, 8000),
    exitCode: r.exitCode
  };
}

