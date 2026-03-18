import * as vscode from "vscode";
import type { AppState } from "./types";

type Provider = "openai" | "anthropic" | "deepseek" | "custom";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("aiDevCoach");
  return {
    enabled: cfg.get<boolean>("cloud.enabled", false),
    provider: cfg.get<Provider>("cloud.provider", "deepseek"),
    apiKey: cfg.get<string>("cloud.apiKey", ""),
    baseUrl: (cfg.get<string>("cloud.baseUrl", "") || "").trim().replace(/\/+$/, ""),
    model: (cfg.get<string>("cloud.model", "gpt-3.5-turbo") || "gpt-3.5-turbo").trim()
  };
}

async function fetchOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  body: { model: string; messages: Array<{ role: string; content: string }>; temperature?: number }
): Promise<string> {
  const url = `${baseUrl}/chat/completions`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Custom API ${r.status}: ${await r.text()}`);
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() || "";
}

function toPlainText(markdownLike: string): string {
  const raw = (markdownLike || "").replace(/```[\s\S]*?```/g, "").trim();
  return raw
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/\s+$/gm, "");
}

export async function answerWithOptionalCloud(prompt: string, state: AppState, evidence?: string): Promise<string> {
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled) return localAnswer(prompt, state);
  if (!apiKey) return "Cloud is enabled but no API key is configured (aiDevCoach.cloud.apiKey).";

  try {
    if (provider === "openai") return toPlainText(await answerOpenAI(prompt, state, apiKey, evidence));
    if (provider === "anthropic") return toPlainText(await answerAnthropic(prompt, state, apiKey, evidence));
    if (provider === "deepseek") return toPlainText(await answerDeepSeek(prompt, state, apiKey, evidence));
    if (provider === "custom") return toPlainText(await answerCustom(prompt, state, apiKey, evidence));
    return "Custom provider selected but baseUrl not configured (aiDevCoach.cloud.baseUrl).";
  } catch (e: unknown) {
    return `Cloud request failed: ${String((e as Error)?.message ?? e)}`;
  }
}

export type AssessmentResult = {
  source: "heuristic" | "llm";
  progress: string;
  deviationScore01: number;
  deviationRationale: string;
  level: "ok" | "warn" | "critical";
  alerts: string[];
  nextActions: string[];
  buildCheckMeaning: string;
};

export async function assessProjectWithOptionalCloud(state: AppState, evidence: string): Promise<AssessmentResult> {
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled || !apiKey.trim()) return localAssessment(state);
  try {
    if (provider === "openai") return await assessWithOpenAI(state, evidence, apiKey);
    if (provider === "anthropic") return await assessWithAnthropic(state, evidence, apiKey);
    if (provider === "deepseek") return await assessWithDeepSeek(state, evidence, apiKey);
    if (provider === "custom") return await assessWithCustom(state, evidence);
    return localAssessment(state);
  } catch {
    return localAssessment(state);
  }
}

export async function summarizeGoalFromText(raw: string): Promise<{ title: string; summary: string; objectives: string[] } | undefined> {
  const { enabled, provider, apiKey } = getConfig();
  const text = (raw || "").trim();
  if (!text) return undefined;

  // If cloud is disabled or no key, fall back to a simple local summary.
  if (!enabled || !apiKey.trim()) {
    const summary = text.slice(0, 400);
    const title = summary.slice(0, 40) || "Imported Goal";
    const objectives = summary
      .split(/[\n。；;!！?？]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6)
      .slice(0, 5);
    return { title, summary, objectives };
  }

  const system = provider === "deepseek"
    ? "你是一个善于从口语化描述中梳理项目目标的助理。请把用户提供的中文/英文对话文本，提炼成一个清晰的项目目标摘要。"
    : "You are a helpful assistant that extracts a clear project goal summary from informal conversation text.";
  const user = [
    "从下面这段文本中，梳理出项目的总体目标，并拆解 3-7 条关键目标点。",
    "",
    "输出必须是 JSON，不能有额外文字。",
    "",
    `原始文本：\n${text}`
  ].join("\n");

  const body = provider === "anthropic"
    ? {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 400,
        messages: [{ role: "user", content: `${system}\n\n${user}\n\nJSON schema:\n{"title": "...","summary": "...","objectives": ["..."]}` }]
      }
    : {
        model: provider === "custom" ? getConfig().model : provider === "openai" ? "gpt-4.1-mini" : "deepseek-chat",
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              user,
              "",
              "JSON schema:",
              '{"title": "一句话项目标题","summary": "1-3 句项目目标总结（中文优先）","objectives": ["拆分后的关键目标点"]}'
            ].join("\n")
          }
        ],
        temperature: 0.2
      };

  try {
    let rawResp = "";
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      rawResp = json.choices?.[0]?.message?.content || "";
    } else if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      rawResp = json.content?.find((c) => c.type === "text")?.text || "";
    } else if (provider === "custom") {
      const { baseUrl } = getConfig();
      if (!baseUrl) return undefined;
      rawResp = await fetchOpenAICompatible(baseUrl, apiKey, body as { model: string; messages: Array<{ role: string; content: string }>; temperature?: number });
    } else {
      const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      rawResp = json.choices?.[0]?.message?.content || "";
    }

    const jsonText = extractJsonObject(rawResp) ?? rawResp.trim();
    const parsed = JSON.parse(jsonText) as Partial<{ title: string; summary: string; objectives: string[] }>;
    const title = (parsed.title || "").toString().trim() || "Imported Goal";
    const summary = (parsed.summary || "").toString().trim() || text.slice(0, 400);
    const objectives = Array.isArray(parsed.objectives)
      ? parsed.objectives.map((x) => String(x)).filter((x) => x.trim().length >= 4).slice(0, 7)
      : [];
    return { title, summary, objectives };
  } catch {
    const summary = text.slice(0, 400);
    const title = summary.slice(0, 40) || "Imported Goal";
    const objectives = summary
      .split(/[\n。；;!！?？]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6)
      .slice(0, 5);
    return { title, summary, objectives };
  }
}

export async function calibratePlanItemsWithOptionalCloud(
  goal: { title: string; summary: string; objectives: string[] } | undefined,
  items: Array<{ text: string; done?: boolean; group?: string }>,
  workspaceFiles: string[]
): Promise<{ applied: boolean; items: Array<{ text: string; done: boolean; group?: string }>; note: string }> {
  const normalizedItems = items.map((x) => ({ text: x.text, done: Boolean(x.done), group: x.group }));
  if (!goal || !items.length) return { applied: false, items: normalizedItems, note: "missing-goal-or-plan" };
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled || !apiKey.trim()) return { applied: false, items: normalizedItems, note: "cloud-disabled" };

  const prompt = [
    "你是项目计划校准助手。请把计划项校准为“可验证、可执行、与当前代码文件相关”的条目。",
    "要求：",
    "1) 保留原有优先级分组（如 P0~P4/回归测试清单），可微调条目文案；",
    "2) 每条必须是可执行动作，尽量指向模块/文件；",
    "3) 删除明显与目标无关或重复项；",
    "4) 返回 JSON 且仅 JSON。",
    'JSON schema: {"items":[{"group":"string","text":"string","done":false}]}',
    "",
    `目标标题: ${goal.title}`,
    `目标摘要: ${goal.summary}`,
    `目标要点: ${(goal.objectives || []).join(" | ") || "(none)"}`,
    "",
    "当前计划项：",
    items.map((x, i) => `${i + 1}. [${x.group || "Ungrouped"}] ${x.text}`).join("\n"),
    "",
    "工作区文件（截断）：",
    workspaceFiles.slice(0, 80).join("\n")
  ].join("\n");

  const callOpenAI = async () => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a plan calibration assistant. Return JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    });
    if (!r.ok) return "";
    const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content || "";
  };
  const callAnthropic = async () => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) return "";
    const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find((c) => c.type === "text")?.text || "";
  };
  const callDeepSeek = async () => {
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "你是计划校准助手，只输出 JSON。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    });
    if (!r.ok) return "";
    const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content || "";
  };
  const callCustom = async () => {
    const { baseUrl, model } = getConfig();
    if (!baseUrl) return "";
    return fetchOpenAICompatible(baseUrl, apiKey, {
      model,
      messages: [
        { role: "system", content: "You are a plan calibration assistant. Return JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });
  };

  try {
    const raw =
      provider === "openai"
        ? await callOpenAI()
        : provider === "anthropic"
          ? await callAnthropic()
          : provider === "deepseek"
            ? await callDeepSeek()
            : provider === "custom"
              ? await callCustom()
              : "";
    const jsonText = extractJsonObject(raw) ?? raw.trim();
    const parsed = JSON.parse(jsonText) as Partial<{ items: Array<{ text: string; done?: boolean; group?: string }> }>;
    const next = Array.isArray(parsed.items)
      ? parsed.items
          .map((x) => ({ text: String(x.text || "").trim(), done: Boolean(x.done), group: String(x.group || "").trim() || undefined }))
          .filter((x) => x.text.length > 0)
      : [];
    if (!next.length) return { applied: false, items: normalizedItems, note: "empty-calibration-result" };
    return { applied: true, items: next, note: `calibrated-${next.length}` };
  } catch {
    return { applied: false, items: normalizedItems, note: "calibration-failed" };
  }
}

export type PlanCompletionInference = {
  available: boolean;
  completed: string[];
  superseded: string[];
  reason?: "ok" | "disabled" | "no-plan" | "provider-not-supported" | "request-failed";
};

/** 1-based plan index -> file paths. LLM decides how many files per item. */
export type FilePathsPerPlanItem = Map<number, string[]>;

function filePathsPrompt(state: AppState, fileInventory: string[]): string {
  const plans = state.plan.map((p, i) => `${i + 1}. ${p.text}`).join("\n");
  const inventory = fileInventory.slice(0, 200).join("\n");
  return [
    "你是代码关联分析助手。根据执行计划与文件路径列表，为每个计划项选出可能包含其实现的文件。",
    "要求：1) 每个计划项可关联 0 到任意多个文件，由你根据语义判断；2) filePaths 必须与 FILE INVENTORY 中的路径完全一致；3) 只输出 JSON。",
    '输出格式：{"items":[{"index":1,"filePaths":["src/config.ts","src/config/index.ts"]},{"index":2,"filePaths":[]}]}',
    "",
    "计划列表：",
    plans,
    "",
    "FILE INVENTORY（路径必须从此列表精确选取）：",
    inventory
  ].join("\n");
}

function parseFilePathsResponse(raw: string, planCount: number, validPaths: Set<string>): FilePathsPerPlanItem {
  const result = new Map<number, string[]>();
  const jsonText = extractJsonObject(raw) ?? raw.trim();
  try {
    const obj = JSON.parse(jsonText) as { items?: Array<{ index?: number; filePaths?: string[] }> };
    const items = Array.isArray(obj.items) ? obj.items : [];
    for (const it of items) {
      const idx = Number(it.index);
      if (!Number.isInteger(idx) || idx < 1 || idx > planCount) continue;
      const paths = Array.isArray(it.filePaths) ? it.filePaths : [];
      const valid = paths
        .map((p) => String(p).trim())
        .filter((p) => validPaths.has(p));
      result.set(idx, valid);
    }
  } catch {
    // ignore
  }
  return result;
}

export async function inferFilePathsForPlanItems(
  state: AppState,
  fileInventory: string[]
): Promise<FilePathsPerPlanItem | undefined> {
  const plans = state.plan.map((p) => p.text.trim()).filter(Boolean);
  if (plans.length === 0 || fileInventory.length === 0) return undefined;
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled || !apiKey.trim()) return undefined;

  const validPaths = new Set(fileInventory);
  const prompt = filePathsPrompt(state, fileInventory);
  const system =
    "You are a code-file relevance analyzer. For each plan item, list file paths from the inventory that likely contain its implementation. No limit on count per item. Return JSON only. Paths must match inventory exactly.";

  try {
    let raw = "";
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "gpt-4.1-mini", messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.1 })
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      raw = json.choices?.[0]?.message?.content || "";
    } else if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 600, messages: [{ role: "user", content: `${system}\n\n${prompt}` }] })
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
      raw = json.content?.find((c) => c.type === "text")?.text || "";
    } else if (provider === "deepseek") {
      const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.1 })
      });
      if (!r.ok) return undefined;
      const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      raw = json.choices?.[0]?.message?.content || "";
    } else if (provider === "custom") {
      const { baseUrl, model } = getConfig();
      if (!baseUrl) return undefined;
      raw = await fetchOpenAICompatible(baseUrl, apiKey, {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        temperature: 0.1
      });
    }
    if (!raw?.trim()) return undefined;
    const parsed = parseFilePathsResponse(raw, plans.length, validPaths);
    return parsed.size > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function inferCompletedPlanTextsWithOptionalCloud(
  state: AppState,
  evidence: string
): Promise<PlanCompletionInference> {
  const plans = state.plan.map((p) => p.text.trim()).filter(Boolean);
  if (plans.length === 0) return { available: false, completed: [], superseded: [], reason: "no-plan" };
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled || !apiKey.trim()) return { available: false, completed: [], superseded: [], reason: "disabled" };
  try {
    if (provider === "openai") return { available: true, ...(await inferCompletedWithOpenAI(state, evidence, apiKey)), reason: "ok" };
    if (provider === "anthropic") return { available: true, ...(await inferCompletedWithAnthropic(state, evidence, apiKey)), reason: "ok" };
    if (provider === "deepseek") return { available: true, ...(await inferCompletedWithDeepSeek(state, evidence, apiKey)), reason: "ok" };
    if (provider === "custom") return { available: true, ...(await inferCompletedWithCustom(state, evidence)), reason: "ok" };
    return { available: false, completed: [], superseded: [], reason: "provider-not-supported" };
  } catch {
    return { available: false, completed: [], superseded: [], reason: "request-failed" };
  }
}

function normalizeCompletedTexts(raw: string, planTexts: string[]): { completed: string[]; superseded: string[] } {
  const jsonText = extractJsonObject(raw) ?? raw.trim();
  let parsedList: string[] = [];
  let parsedIndices: number[] = [];
  let parsedSuperseded: string[] = [];
  let parsedSupersededIndices: number[] = [];
  const normalizeForMatch = (s: string) =>
    s
      .toLowerCase()
      .replace(/[`"'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[，。！？；：,.!?;:()（）【】\[\]-]/g, "")
      .trim();

  try {
    const obj = JSON.parse(jsonText) as Partial<{
      completed: string[];
      completedIndices: number[];
      superseded: string[];
      supersededIndices: number[];
      items?: Array<{ index: number; status?: string; evidence?: string }>;
    }>;
    const itemsArr = Array.isArray(obj.items) ? obj.items : [];
    const hasItemsFormat = itemsArr.length > 0;
    if (hasItemsFormat) {
      for (const it of itemsArr) {
        const idx = Number(it.index);
        if (!Number.isInteger(idx) || idx < 1 || idx > planTexts.length) continue;
        const status = String(it.status || "").toLowerCase();
        const evidence = String(it.evidence || "").trim();
        if (status === "completed" && evidence.length >= 4) parsedIndices.push(idx);
        else if (status === "superseded") parsedSupersededIndices.push(idx);
      }
    }
    if (Array.isArray(obj.completed)) parsedList = obj.completed.map((x) => String(x).trim()).filter(Boolean);
    if (!hasItemsFormat && Array.isArray(obj.completedIndices)) {
      parsedIndices.push(
        ...obj.completedIndices
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x >= 1 && x <= planTexts.length)
      );
    }
    if (Array.isArray(obj.superseded)) parsedSuperseded = obj.superseded.map((x) => String(x).trim()).filter(Boolean);
    if (Array.isArray(obj.supersededIndices)) {
      parsedSupersededIndices.push(
        ...obj.supersededIndices
          .map((x) => Number(x))
          .filter((x) => Number.isInteger(x) && x >= 1 && x <= planTexts.length)
      );
    }
  } catch {
    parsedList = [];
    parsedIndices = [];
    parsedSuperseded = [];
    parsedSupersededIndices = [];
  }
  if (!parsedList.length && !parsedIndices.length && !parsedSuperseded.length && !parsedSupersededIndices.length) {
    return { completed: [], superseded: [] };
  }

  const completedSet = new Set<string>();
  const supersededSet = new Set<string>();
  for (const idx of parsedIndices) completedSet.add(planTexts[idx - 1] as string);
  for (const idx of parsedSupersededIndices) supersededSet.add(planTexts[idx - 1] as string);

  const planByNorm = new Map(planTexts.map((x) => [normalizeForMatch(x), x]));
  for (const item of parsedList) {
    const direct = planByNorm.get(normalizeForMatch(item));
    if (direct) {
      completedSet.add(direct);
      continue;
    }
    const itemNorm = normalizeForMatch(item);
    if (!itemNorm) continue;
    for (const [norm, original] of planByNorm) {
      if (itemNorm.includes(norm) || norm.includes(itemNorm)) {
        completedSet.add(original);
        break;
      }
    }
  }
  for (const item of parsedSuperseded) {
    const direct = planByNorm.get(normalizeForMatch(item));
    if (direct) {
      supersededSet.add(direct);
      continue;
    }
    const itemNorm = normalizeForMatch(item);
    if (!itemNorm) continue;
    for (const [norm, original] of planByNorm) {
      if (itemNorm.includes(norm) || norm.includes(itemNorm)) {
        supersededSet.add(original);
        break;
      }
    }
  }
  for (const x of supersededSet) completedSet.delete(x);
  return { completed: Array.from(completedSet), superseded: Array.from(supersededSet) };
}

function completedPlanPrompt(state: AppState, evidence: string): string {
  const plans = state.plan.map((p, i) => `${i + 1}. ${p.text}`).join("\n");
  return [
    "你是开发进度审计助手。代码证据已按计划项分组：每个「=== 计划项 N: ... ===」下是对该步骤最相关的文件内容。",
    "请逐项比对：在对应计划项的证据块中查找实现，若找到则引用 FILE 路径及关键代码作为 evidence；无法引用则保持 todo。",
    "",
    "比照流程：",
    "1) 计划项 N 的证据在「=== 计划项 N: ... ===」块中，优先在该块内查找；",
    "2) 若找到实现，必须引用具体 FILE 路径及关键代码/函数/模块名；",
    "3) 仅当能明确引用证据时，才标记 completed；evidence 为空或过短（<4 字符）则必须保持 todo；",
    "4) superseded：实现方式与计划不同但功能已达成（需引用替代实现所在文件）。",
    "",
    "严格约束：宁可漏判不可错判。输出必须是 JSON 且仅 JSON，使用 items 格式：",
    '{"items":[{"index":1,"status":"completed","evidence":"FILE src/config.ts: ConfigModule 类"},{"index":2,"status":"todo","evidence":""}]}',
    "",
    "计划列表：",
    plans,
    "",
    "代码证据（按计划项分组，每块下为该步骤相关文件）：",
    evidence
  ].join("\n");
}

async function inferCompletedWithOpenAI(
  state: AppState,
  evidence: string,
  apiKey: string
): Promise<{ completed: string[]; superseded: string[] }> {
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a development progress auditor. Compare each plan item against CODE SNAPSHOTS one by one. Ignore any existing plan status; judge purely from code evidence. For each completed item, you MUST cite the FILE path and key code/function as evidence. Use items format with index, status, evidence. No evidence or evidence<4 chars = must stay todo. Prefer false negatives over false positives. Return JSON only."
      },
      { role: "user", content: completedPlanPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { completed: [], superseded: [] };
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

async function inferCompletedWithAnthropic(
  state: AppState,
  evidence: string,
  apiKey: string
): Promise<{ completed: string[]; superseded: string[] }> {
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 800,
    messages: [{ role: "user", content: completedPlanPrompt(state, evidence) }]
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { completed: [], superseded: [] };
  const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw = json.content?.find((c) => c.type === "text")?.text || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

async function inferCompletedWithDeepSeek(
  state: AppState,
  evidence: string,
  apiKey: string
): Promise<{ completed: string[]; superseded: string[] }> {
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          "你是开发进度审计助手。必须逐项比对计划与代码，完全基于 CODE SNAPSHOTS 判断，忽略已有计划状态。标记 completed 时必须引用 FILE 路径及关键代码作为 evidence；无法引用或 evidence 过短则不得标记。宁可漏判不可错判。使用 items 格式输出，含 index、status、evidence。输出 JSON 且仅 JSON。"
      },
      { role: "user", content: completedPlanPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { completed: [], superseded: [] };
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

async function inferCompletedWithCustom(
  state: AppState,
  evidence: string
): Promise<{ completed: string[]; superseded: string[] }> {
  const { baseUrl, apiKey, model } = getConfig();
  if (!baseUrl) return { completed: [], superseded: [] };
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a development progress auditor. Compare each plan item against CODE SNAPSHOTS. Ignore existing plan status; judge from code only. For completed items, cite FILE path and key code as evidence. No evidence = stay todo. Use items format. Return JSON only."
      },
      { role: "user", content: completedPlanPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const raw = await fetchOpenAICompatible(baseUrl, apiKey, body);
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

function localAnswer(prompt: string, state: AppState): string {
  const p = prompt.toLowerCase();
  const diag = state.diagnostics;
  const topPlan = state.plan
    .slice(0, 5)
    .map((s, i) => `${i + 1}) ${s.done ? "[x]" : "[ ]"} ${s.text}`)
    .join("\n");
  const validity = state.validity.state;
  const goal = state.goal.summary || "No goal baseline.";

  if (p.includes("deviation") || prompt.includes("偏离")) {
    return `Deviation: ${Math.round(state.deviation.score01 * 100)}%\nReason: ${state.deviation.rationale}\nGoal: ${goal}`;
  }
  if (p.includes("error") || prompt.includes("报错") || prompt.includes("诊断")) {
    return [
      "Diagnostics summary:",
      `errors: ${diag.errors}`,
      `warnings: ${diag.warnings}`,
      `info: ${diag.infos}`,
      `hint: ${diag.hints}`,
      "",
      `Validity: ${validity}`
    ].join("\n");
  }
  if (p.includes("next") || prompt.includes("下一步") || prompt.includes("建议")) {
    const suggestions: string[] = [];
    if (diag.errors > 0) suggestions.push("Fix current Errors in Problems panel first (they heavily impact validity/deviation).");
    else if (validity === "failed") suggestions.push("Re-run the build check and inspect build output tail; update build command if needed.");
    else suggestions.push("Add/complete plan steps, then run validity check after each meaningful change.");
    const lines: string[] = [];
    lines.push("Next steps:");
    suggestions.forEach((s, idx) => {
      lines.push(`${idx + 1}) ${s}`);
    });
    lines.push("");
    lines.push("Goal:");
    lines.push(goal);
    lines.push("");
    lines.push("Top plan:");
    lines.push(topPlan || "(no plan steps yet)");
    return lines.join("\n");
  }

  return [
    "Current status:",
    `goal: ${goal}`,
    `deviation: ${Math.round(state.deviation.score01 * 100)}% (${state.deviation.rationale})`,
    `diagnostics: ${diag.errors} errors, ${diag.warnings} warnings`,
    `validity: ${validity}`,
    "",
    'Ask me about "errors", "deviation", or "next steps".'
  ].join("\n");
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function localAssessment(state: AppState): AssessmentResult {
  const done = state.plan.filter((p) => p.done).length;
  const total = state.plan.length;
  let score = state.deviation.score01;
  const alerts = [...state.monitor.reasons];
  const nextActions = [...state.monitor.nextActions];
  if (!nextActions.length) {
    const nextPlan = state.plan.find((p) => !p.done)?.text;
    if (nextPlan) nextActions.push(nextPlan);
  }
  if (state.validity.state === "failed") score = Math.max(score, 0.5);
  const progress = `计划完成 ${done}/${total}；诊断 ${state.diagnostics.errors} 错误 / ${state.diagnostics.warnings} 警告；构建状态 ${state.validity.state}。`;
  return {
    source: "heuristic",
    progress,
    deviationScore01: clamp01(score),
    deviationRationale: state.deviation.rationale,
    level: state.monitor.level,
    alerts: alerts.length ? alerts : ["开发信号正常。"],
    nextActions: nextActions.length ? nextActions.slice(0, 4) : ["继续完成下一个未完成计划项并验证。"],
    buildCheckMeaning: "构建校验用于验证你配置（或自动推断）的构建命令是否可通过，并可在通过后继续执行测试。"
  };
}

function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1).trim();
  return undefined;
}

function parseAssessment(raw: string): AssessmentResult | undefined {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return undefined;
  try {
    const obj = JSON.parse(jsonText) as Partial<AssessmentResult>;
    const level = obj.level === "critical" || obj.level === "warn" || obj.level === "ok" ? obj.level : "warn";
    return {
      source: "llm",
      progress: String(obj.progress || "").trim() || "证据不足，无法给出可靠进度。",
      deviationScore01: clamp01(Number(obj.deviationScore01 ?? 0.4)),
      deviationRationale: String(obj.deviationRationale || "").trim() || "模型未返回偏离依据。",
      level,
      alerts: Array.isArray(obj.alerts) ? obj.alerts.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [],
      nextActions: Array.isArray(obj.nextActions) ? obj.nextActions.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [],
      buildCheckMeaning:
        String(obj.buildCheckMeaning || "").trim() || "构建校验用于验证你配置（或自动推断）的构建命令是否可通过，并可在通过后继续执行测试。"
    };
  } catch {
    return undefined;
  }
}

function textFallbackAssessment(raw: string, state: AppState): AssessmentResult {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const progress = lines[0] || "已获取 LLM 评估结果。";
  const actionLines = lines
    .filter((x) => /^[-*•\d.]/.test(x))
    .map((x) => x.replace(/^[-*•\d.\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const deviation = Math.max(0, Math.min(1, state.deviation.score01));
  const level: AssessmentResult["level"] = deviation > 0.55 ? "critical" : deviation > 0.25 ? "warn" : "ok";
  return {
    source: "llm",
    progress,
    deviationScore01: deviation,
    deviationRationale: "LLM 已返回文本评估（非 JSON），已做兼容解析。",
    level,
    alerts: ["LLM 评估文本已接入。"],
    nextActions: actionLines.length ? actionLines : ["请根据 LLM 建议执行下一步代码修改并保存触发刷新。"],
    buildCheckMeaning: "构建校验用于验证你配置（或自动推断）的构建命令是否可通过，并可在通过后继续执行测试。"
  };
}

function assessmentPrompt(state: AppState, evidence: string): string {
  return [
    "你是 AI 编程监理器。请根据工作区代码证据进行真实评估，不允许套话。",
    "输出必须是 JSON 对象，不要输出任何解释文字。",
    "JSON schema:",
    `{
  "progress": "string, 1-2句, 明确当前已完成到哪里",
  "deviationScore01": "number, 0-1, 0=无偏离(好) 1=严重偏离(坏)",
  "deviationRationale": "string, 必须引用证据",
  "level": "ok|warn|critical",
  "alerts": ["string"],
  "nextActions": ["string, 必须是具体开发动作，不得复述目标，不得写 Implement and verify: ..."],
  "buildCheckMeaning": "string, 简短解释构建校验意义"
}`,
    "",
    "评估要求：",
    "1) nextActions 必须是可执行步骤（改哪个文件/模块、补哪类测试、跑什么命令）；",
    "2) 进度要基于代码/诊断/计划，不得只复述用户目标；",
    "3) 如果证据不足，alerts 和 nextActions 里明确缺什么证据；",
    "4) 若计划文本与代码证据明显不符（如计划说未完成但代码已有实现、或计划步骤与代码结构脱节），必须在 nextActions 或 alerts 中明确建议「更新 plan.md 以反映当前代码状态」；",
    "5) 语言使用中文。",
    "",
    "关键约束（必须遵守）：",
    "- 若 CODE SNAPSHOTS 或 FILE INVENTORY 中已有相关实现/文件，不得建议「补实现」「完成 X」；应视为已完成。",
    "- 不得仅凭 PLAN 中的 [todo] 就断言未完成；必须对照 CODE SNAPSHOTS 和 FILE INVENTORY，若证据中已有对应文件/函数/模块，应视为完成。",
    "- 若诊断 0 错误、构建通过，且证据显示功能已实现，level 应为 ok，nextActions 可建议「继续下一项」而非补实现。",
    "",
    "当前状态信号：",
    `- 偏离度(旧): ${Math.round(state.deviation.score01 * 100)}% | ${state.deviation.rationale}`,
    `- 监理(旧): ${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
    "",
    "工作区证据：",
    evidence
  ].join("\n");
}

async function assessWithOpenAI(state: AppState, evidence: string, apiKey: string): Promise<AssessmentResult> {
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a code supervision evaluator. Return JSON only. Trust CODE SNAPSHOTS over plan [todo]; do not suggest implementing what already exists in evidence."
      },
      { role: "user", content: assessmentPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content?.trim() || "";
  return parseAssessment(raw) || (raw ? textFallbackAssessment(raw, state) : localAssessment(state));
}

async function assessWithAnthropic(state: AppState, evidence: string, apiKey: string): Promise<AssessmentResult> {
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 500,
    messages: [{ role: "user", content: assessmentPrompt(state, evidence) }]
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw = json.content?.find((c) => c.type === "text")?.text?.trim() || "";
  return parseAssessment(raw) || (raw ? textFallbackAssessment(raw, state) : localAssessment(state));
}

async function assessWithDeepSeek(state: AppState, evidence: string, apiKey: string): Promise<AssessmentResult> {
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          "你是项目监理助手。你必须基于代码证据评估进度和偏离。输出 JSON 且仅 JSON。优先信任 CODE SNAPSHOTS，若证据中已有实现则不得建议补实现。"
      },
      { role: "user", content: assessmentPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`DeepSeek ${r.status}`);
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content?.trim() || "";
  return parseAssessment(raw) || (raw ? textFallbackAssessment(raw, state) : localAssessment(state));
}

async function assessWithCustom(state: AppState, evidence: string): Promise<AssessmentResult> {
  const { baseUrl, apiKey, model } = getConfig();
  if (!baseUrl) throw new Error("Custom provider requires aiDevCoach.cloud.baseUrl.");
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a code supervision evaluator. Return JSON only. Trust CODE SNAPSHOTS over plan [todo]; do not suggest implementing what already exists in evidence."
      },
      { role: "user", content: assessmentPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const raw = await fetchOpenAICompatible(baseUrl, apiKey, body);
  return parseAssessment(raw) || (raw ? textFallbackAssessment(raw, state) : localAssessment(state));
}

function chatEvidenceBlock(evidence?: string): string {
  if (!evidence?.trim()) return "Code evidence: (not provided)";
  const trimmed = evidence.length > 7000 ? `${evidence.slice(0, 7000)}\n...(truncated)` : evidence;
  return `Code evidence:\n${trimmed}`;
}

async function answerOpenAI(prompt: string, state: AppState, apiKey: string, evidence?: string): Promise<string> {
  // Minimal call (no tool calling). We keep payload small: high-level signals only.
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          [
            "You are a VS Code engineering coach.",
            "Answer only from provided project signals and evidence.",
            "If evidence is insufficient, explicitly say so and request the exact missing artifact.",
            "Do not assume that TODO items in plan text mean code is unimplemented; prefer concrete code snapshots and recent events.",
            "Never claim something is definitely unimplemented unless you clearly see no relevant files/functions in the FILE INVENTORY and CODE SNAPSHOTS.",
            "Output plain text only (no markdown, no bullet markers like '-' or '*', no numbered markdown lists)."
          ].join(" ")
      },
      {
        role: "user",
        content: [
          "User question:",
          prompt,
          "",
          "Current signals:",
          `- goal: ${state.goal.title} | ${state.goal.summary} (source: ${state.goal.source || "none"})`,
          `- plan progress: ${state.plan.length > 0 ? Math.round(((state.plan.filter((p) => p.done).length + state.plan.filter((p) => p.superseded).length) / state.plan.length) * 100) : 0}% (done+superseded/total, raw plan completion)`,
          `- deviation: ${Math.round(state.deviation.score01 * 100)}% (composite score, not plan completion; ${state.deviation.rationale})`,
          `- diagnostics: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`,
          `- validity: ${state.validity.state}`,
          `- monitor: ${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `- planSteps: ${state.plan.slice(0, 10).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`).join(" | ") || "(none)"}`,
          "",
          chatEvidenceBlock(evidence),
          "",
          "Output rules:",
          "1) Always reference at least 2 concrete signals/evidence points.",
          "2) Give 2-4 specific next coding actions (file/module oriented when possible).",
          "3) No generic motivation text.",
          "4) If plan text and code evidence conflict, trust the current code and runtime signals more than the original plan.md.",
          ""
        ].join("\n")
      }
    ],
    temperature: 0.2
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 400)}`);
  }
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  return text || "(empty response)";
}

async function answerAnthropic(prompt: string, state: AppState, apiKey: string, evidence?: string): Promise<string> {
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          "You are a VS Code assistant focused on development progress, goal deviation, and code validity.",
          "Answer only from provided project signals and evidence.",
          "If evidence is insufficient, explicitly say so and request the exact missing artifact.",
          "Do not assume that TODO items in plan text mean code is unimplemented; prefer concrete code snapshots and recent events.",
          "Never claim something is definitely unimplemented unless you clearly see no relevant files/functions in the FILE INVENTORY and CODE SNAPSHOTS.",
          "Output plain text only (no markdown, no bullet markers like '-' or '*', no numbered markdown lists).",
          "",
          "User question:",
          prompt,
          "",
          "Current signals:",
          `Goal: ${state.goal.title} | ${state.goal.summary} (source: ${state.goal.source || "none"})`,
          `Plan progress: ${state.plan.length > 0 ? Math.round(((state.plan.filter((p) => p.done).length + state.plan.filter((p) => p.superseded).length) / state.plan.length) * 100) : 0}% (done+superseded/total)`,
          `Deviation: ${Math.round(state.deviation.score01 * 100)}% (composite, not plan completion; ${state.deviation.rationale})`,
          `Diagnostics: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`,
          `Validity: ${state.validity.state}`,
          `Monitor: ${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `Plan: ${state.plan.slice(0, 10).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`).join(" | ") || "(none)"}`,
          "",
          chatEvidenceBlock(evidence),
          "",
          "Rules: cite concrete evidence, avoid generic replies, provide actionable next steps.",
          "If plan text and code evidence conflict, trust the current code and runtime signals more than the original plan.md."
        ].join("\n")
      }
    ]
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic HTTP ${r.status}: ${t.slice(0, 400)}`);
  }
  const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = json.content?.find((c) => c.type === "text")?.text?.trim();
  return text || "(empty response)";
}

async function answerDeepSeek(prompt: string, state: AppState, apiKey: string, evidence?: string): Promise<string> {
  // DeepSeek 提供 OpenAI 兼容接口，这里按 chat/completions 调用
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          [
            "你是代码开发监理与指导助手。",
            "必须围绕“用户问题-当前证据-可执行动作”回答，禁止空泛回答。",
            "若证据不足必须明确写出“证据不足”并指出缺失证据。",
            "不要仅依据 PLAN 文本中的 TODO 字样就断言模块未实现；优先相信 CODE SNAPSHOTS、RECENT EVENTS 和当前运行信号。",
            "除非在 FILE INVENTORY 和 CODE SNAPSHOTS 中明确看不到相关文件/函数，否则不要用“尚未实现”这类绝对表述，可以说“从当前证据看可能仍在进行中”。",
            "回答必须是普通多行文本，不能使用 Markdown 语法（不要用 '-'、'*' 作为列表符号，不要用 '**' 加粗）。"
          ].join(" ")
      },
      {
        role: "user",
        content: [
          "用户问题：",
          prompt,
          "",
          "当前信号：",
          `- 目标基线：${state.goal.title} | ${state.goal.summary}（来源：${state.goal.source || "none"}）`,
          `- 计划完成率：${state.plan.length > 0 ? Math.round(((state.plan.filter((p) => p.done).length + state.plan.filter((p) => p.superseded).length) / state.plan.length) * 100) : 0}%（done+superseded/total，纯计划完成度）`,
          `- 偏离度：${Math.round(state.deviation.score01 * 100)}%（综合评分，非计划完成率；${state.deviation.rationale}）`,
          `- 诊断：${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings, ${state.diagnostics.infos} info, ${state.diagnostics.hints} hints`,
          `- 有效性（构建）：${state.validity.state}`,
          `- 监理告警：${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `- 计划步骤（前 10 条）：`,
          state.plan
            .slice(0, 10)
            .map((s, i) => `${i + 1}. ${s.done ? "[已完成]" : "[未完成]"} ${s.text}`)
            .join("\n") || "(暂无计划)",
          "",
          chatEvidenceBlock(evidence),
          "",
          "请你基于以上信息，用 4~7 条要点说明：",
          "1）当前实现与目标/计划的偏差（必须引用上面的信号，不要猜；PLAN 文本与代码/事件冲突时，以代码和运行信号为准）；",
          "2）若存在 AI 兜圈子/无效推进风险，要明确指出并给出反制动作；",
          "3）给出接下来 2~4 个具体行动（例如修哪个错误、补哪一步实现、补哪种测试），每条都尽量指向可执行的 IDE / 代码操作。",
          "4）若关键证据不足，明确写出还缺什么证据。"
        ].join("\n")
      }
    ],
    temperature: 0.2
  };

  const r = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`DeepSeek HTTP ${r.status}: ${t.slice(0, 400)}`);
  }
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  return text || "(empty response)";
}

async function answerCustom(prompt: string, state: AppState, apiKey: string, evidence?: string): Promise<string> {
  const { baseUrl, model } = getConfig();
  if (!baseUrl) throw new Error("Custom provider requires aiDevCoach.cloud.baseUrl.");
  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          [
            "You are a VS Code engineering coach.",
            "Answer only from provided project signals and evidence.",
            "If evidence is insufficient, explicitly say so and request the exact missing artifact.",
            "Output plain text only (no markdown, no bullet markers)."
          ].join(" ")
      },
      {
        role: "user",
        content: [
          "User question:",
          prompt,
          "",
          "Current signals:",
          `- goal: ${state.goal.title} | ${state.goal.summary}`,
          `- plan progress: ${state.plan.length > 0 ? Math.round(((state.plan.filter((p) => p.done).length + state.plan.filter((p) => p.superseded).length) / state.plan.length) * 100) : 0}%`,
          `- deviation: ${Math.round(state.deviation.score01 * 100)}%`,
          `- diagnostics: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`,
          `- validity: ${state.validity.state}`,
          "",
          chatEvidenceBlock(evidence)
        ].join("\n")
      }
    ],
    temperature: 0.2
  };
  return fetchOpenAICompatible(baseUrl, apiKey, body) || "(empty response)";
}

