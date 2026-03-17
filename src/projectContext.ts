import * as vscode from "vscode";
import type { AppState } from "./types";

function truncate(s: string, max: number) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...(truncated)`;
}

function parsePathFromTimeline(summary: string): string | undefined {
  const m = summary.match(/^(?:Opened|Changed|Saved):\s+(.+)$/i);
  return m?.[1]?.trim();
}

async function readFileSafe(uri: vscode.Uri, maxChars: number): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return truncate(text, maxChars);
  } catch {
    return undefined;
  }
}

export async function buildProjectEvidence(state: AppState): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return "No workspace folder.";

  const relSeen = new Set<string>();
  const recentFromTimeline: string[] = [];
  for (const ev of state.timeline) {
    const rel = parsePathFromTimeline(ev.summary);
    if (!rel || relSeen.has(rel)) continue;
    relSeen.add(rel);
    recentFromTimeline.push(rel);
    if (recentFromTimeline.length >= 8) break;
  }

  const planEvidenceRels = new Set<string>();
  for (const step of state.plan) {
    for (const p of step.evidencePaths ?? []) {
      const r = String(p).trim();
      if (r) planEvidenceRels.add(r);
    }
  }
  const planEvidenceUris: vscode.Uri[] = [];
  for (const rel of planEvidenceRels) {
    planEvidenceUris.push(vscode.Uri.joinPath(ws.uri, rel));
  }

  const include = "**/*.{ts,tsx,js,jsx,json,md,yml,yaml}";
  const exclude = "**/{node_modules,dist,.git,out,.next,coverage}/**";
  const uris = await vscode.workspace.findFiles(include, exclude, 60);
  const sections: string[] = [];

  const recentUris: vscode.Uri[] = [];
  for (const rel of recentFromTimeline) {
    const uri = vscode.Uri.joinPath(ws.uri, rel);
    recentUris.push(uri);
  }

  const seenUri = new Set<string>();
  const dedup = (list: vscode.Uri[]) => {
    const out: vscode.Uri[] = [];
    for (const u of list) {
      const rel = vscode.workspace.asRelativePath(u);
      if (seenUri.has(rel)) continue;
      seenUri.add(rel);
      out.push(u);
    }
    return out;
  };
  const merged = [...dedup(planEvidenceUris), ...dedup(recentUris), ...dedup(uris)].slice(0, 40);
  for (const uri of merged) {
    const rel = vscode.workspace.asRelativePath(uri);
    if (relSeen.has(`seen:${rel}`)) continue;
    relSeen.add(`seen:${rel}`);
    const txt = await readFileSafe(uri, 2200);
    if (!txt?.trim()) continue;
    sections.push(`FILE: ${rel}\n${txt}`);
    if (sections.length >= 28) break;
  }

  const planPreview = state.plan
    .slice(0, 40)
    .map(
      (p, i) =>
        `${i + 1}. [${p.group || "Ungrouped"}] ${p.done ? "[done]" : p.superseded ? "[superseded]" : "[todo]"} ${p.text}${p.evidencePaths?.length ? ` | paths: ${p.evidencePaths.join(", ")}` : ""}`
    )
    .join("\n");
  const fileInventory = uris.slice(0, 120).map((u) => vscode.workspace.asRelativePath(u)).join("\n");
  const recentEvents = state.timeline
    .slice(0, 16)
    .map((e) => `${new Date(e.ts).toISOString()} | ${e.type} | ${e.summary}`)
    .join("\n");

  const doneCount = state.plan.filter((p) => p.done).length;
  const supersededCount = state.plan.filter((p) => p.superseded).length;
  const planTotal = state.plan.length;
  const planProgressPct =
    planTotal > 0 ? Math.round(((doneCount + supersededCount) / planTotal) * 100) : 0;
  const deviationPct = Math.round(state.deviation.score01 * 100);

  return [
    `WORKSPACE: ${ws.uri.fsPath}`,
    `GOAL: ${state.goal.title} | ${state.goal.summary}`,
    `GOAL_SOURCE: ${state.goal.source || "none"}`,
    `OBJECTIVES: ${(state.goal.objectives || []).join(" | ") || "(none)"}`,
    `PLAN_PROGRESS: ${doneCount} done + ${supersededCount} superseded / ${planTotal} = ${planProgressPct}% (raw plan completion)`,
    `DEVIATION: ${deviationPct}% (composite score, not plan completion; factors: plan, diagnostics, build, monitor)`,
    `DIAGNOSTICS: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings, ${state.diagnostics.infos} infos, ${state.diagnostics.hints} hints`,
    `BUILD: ${state.validity.state}`,
    "PLAN:",
    planPreview || "(none)",
    "",
    "RECENT EVENTS:",
    recentEvents || "(none)",
    "",
    "FILE INVENTORY:",
    fileInventory || "(none)",
    "",
    "CODE SNAPSHOTS:",
    sections.join("\n\n---\n\n") || "(no readable source files)"
  ].join("\n");
}

