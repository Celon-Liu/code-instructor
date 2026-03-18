import * as vscode from "vscode";
import type { AppState, PlanStep } from "./types";
import type { FilePathsPerPlanItem } from "./llm";
import { inferFilePathsForPlanItems } from "./llm";

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

/** Score workspace files by relevance to plan step text. Returns top N paths. */
function rankFilesForStep(step: PlanStep, allPaths: string[], topN: number): string[] {
  const fromEvidence = new Set((step.evidencePaths ?? []).map((p) => String(p).trim()).filter(Boolean));
  const scored: Array<{ path: string; score: number }> = [];

  for (const p of allPaths) {
    const rel = p.toLowerCase();
    let score = 0;
    if (fromEvidence.has(p)) score += 10;

    const tokens = step.text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
    for (const t of tokens) {
      if (rel.includes(t)) score += 2;
    }
    if (step.text.length >= 2) {
      const normalized = step.text.replace(/\s+/g, "");
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= normalized.length - len; i++) {
          const seg = normalized.slice(i, i + len);
          if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(seg) && rel.includes(seg)) {
            score += 1;
            break;
          }
        }
      }
    }
    if (score > 0) scored.push({ path: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, topN)
    .map((x) => x.path)
    .filter((p, i, arr) => arr.indexOf(p) === i);
}

const FILES_PER_PLAN_ITEM_FALLBACK = 6;
const MAX_PLAN_ITEMS_FOR_EVIDENCE = 40;

/** Build evidence with per-plan-item structure. Uses filePathsPerItem when provided (LLM-selected); else heuristic. */
async function buildPerPlanItemEvidence(
  state: AppState,
  allPaths: string[],
  fileCache: Map<string, string>,
  filePathsPerItem?: FilePathsPerPlanItem
): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return "";

  const steps = state.plan.slice(0, MAX_PLAN_ITEMS_FOR_EVIDENCE);
  const blocks: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const ranked =
      filePathsPerItem?.get(i + 1) ?? rankFilesForStep(step, allPaths, FILES_PER_PLAN_ITEM_FALLBACK);
    if (ranked.length === 0) continue;

    const itemSections: string[] = [];
    for (const rel of ranked) {
      let txt = fileCache.get(rel);
      if (txt === undefined) {
        const uri = vscode.Uri.joinPath(ws.uri, rel);
        const isTest =
          /\.test\.(ts|tsx|js|jsx)$|_test\.py$|test_.*\.py$/i.test(rel);
        txt = (await readFileSafe(uri, isTest ? 4000 : 3500)) || "";
        fileCache.set(rel, txt);
      }
      if (txt?.trim()) itemSections.push(`FILE: ${rel}\n${txt}`);
    }
    if (itemSections.length > 0) {
      blocks.push(`=== 计划项 ${i + 1}: ${step.text} ===\n${itemSections.join("\n\n")}`);
    }
  }

  const usedRels = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const paths = filePathsPerItem?.get(i + 1) ?? rankFilesForStep(step, allPaths, FILES_PER_PLAN_ITEM_FALLBACK);
    for (const p of paths) usedRels.add(p);
  }
  const recentRels = new Set<string>();
  for (const ev of state.timeline) {
    const r = parsePathFromTimeline(ev.summary);
    if (r && !usedRels.has(r)) recentRels.add(r);
  }
  const unused = allPaths.filter((p) => !usedRels.has(p));
  const recentFirst = unused.filter((p) => recentRels.has(p));
  const testFiles = unused.filter((p) => /\.test\.(ts|tsx|js|jsx)$/i.test(p));
  const otherPaths = [...recentFirst, ...testFiles.filter((p) => !recentFirst.includes(p)), ...unused.filter((p) => !recentFirst.includes(p) && !/\.test\.(ts|tsx|js|jsx)$/i.test(p))].slice(0, 20);
  const otherSections: string[] = [];
  for (const rel of otherPaths) {
    let txt = fileCache.get(rel);
    if (txt === undefined) {
      const uri = vscode.Uri.joinPath(ws.uri, rel);
      const isTest =
        /\.test\.(ts|tsx|js|jsx)$|_test\.py$|test_.*\.py$/i.test(rel);
      txt = (await readFileSafe(uri, isTest ? 4000 : 3500)) || "";
      fileCache.set(rel, txt);
    }
    if (txt?.trim()) otherSections.push(`FILE: ${rel}\n${txt}`);
  }
  if (otherSections.length > 0) {
    blocks.push(`=== 其他相关文件 ===\n${otherSections.join("\n\n")}`);
  }

  return blocks.join("\n\n---\n\n");
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

  const include =
    "**/*.{ts,tsx,js,jsx,json,md,yml,yaml,py,pyi,go,rs,java,kt,c,cpp,h}";
  const exclude = "**/{node_modules,dist,.git,out,.next,coverage,__pycache__,venv,.venv}/**";
  const uris = await vscode.workspace.findFiles(include, exclude, 150);
  const allPaths = uris.map((u) => vscode.workspace.asRelativePath(u));
  const fileCache = new Map<string, string>();

  let codeSnapshots: string;
  if (state.plan.length > 0) {
    const llmFilePaths = await inferFilePathsForPlanItems(state, allPaths);
    codeSnapshots = await buildPerPlanItemEvidence(state, allPaths, fileCache, llmFilePaths);
  } else {
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
    const recentUris = recentFromTimeline.map((rel) => vscode.Uri.joinPath(ws.uri, rel));
    const testFileUris = uris.filter((u) => /\.test\.(ts|tsx|js|jsx)$/i.test(vscode.workspace.asRelativePath(u)));
    const seenUri = new Set<string>();
    const dedup = (list: vscode.Uri[]) => {
      const out: vscode.Uri[] = [];
      for (const u of list) {
        const r = vscode.workspace.asRelativePath(u);
        if (seenUri.has(r)) continue;
        seenUri.add(r);
        out.push(u);
      }
      return out;
    };
    const merged = [...dedup(planEvidenceUris), ...dedup(testFileUris), ...dedup(recentUris), ...dedup(uris)].slice(0, 100);
    const sections: string[] = [];
    for (const uri of merged) {
      const rel = vscode.workspace.asRelativePath(uri);
      if (relSeen.has(`seen:${rel}`)) continue;
      relSeen.add(`seen:${rel}`);
      const isTest =
        /\.test\.(ts|tsx|js|jsx)$|_test\.py$|test_.*\.py$/i.test(rel);
      const txt = await readFileSafe(uri, isTest ? 4000 : 3500);
      if (txt?.trim()) sections.push(`FILE: ${rel}\n${txt}`);
      if (sections.length >= 60) break;
    }
    codeSnapshots = sections.join("\n\n---\n\n") || "(no readable source files)";
  }

  const planPreview = state.plan
    .slice(0, 40)
    .map(
      (p, i) =>
        `${i + 1}. [${p.group || "Ungrouped"}] ${p.done ? "[done]" : p.superseded ? "[superseded]" : "[todo]"} ${p.text}${p.evidencePaths?.length ? ` | paths: ${p.evidencePaths.join(", ")}` : ""}`
    )
    .join("\n");
  const fileInventory = uris.slice(0, 200).map((u) => vscode.workspace.asRelativePath(u)).join("\n");
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
    codeSnapshots || "(no readable source files)"
  ].join("\n");
}

