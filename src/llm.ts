import * as vscode from "vscode";
import type { AppState } from "./types";

type Provider = "openai" | "anthropic" | "deepseek" | "custom";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("aiDevCoach");
  return {
    enabled: cfg.get<boolean>("cloud.enabled", false),
    provider: cfg.get<Provider>("cloud.provider", "deepseek"),
    apiKey: cfg.get<string>("cloud.apiKey", "")
  };
}

export async function answerWithOptionalCloud(prompt: string, state: AppState): Promise<string> {
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled) return localAnswer(prompt, state);
  if (!apiKey) return "Cloud is enabled but no API key is configured (`aiDevCoach.cloud.apiKey`).";

  try {
    if (provider === "openai") return await answerOpenAI(prompt, state, apiKey);
    if (provider === "anthropic") return await answerAnthropic(prompt, state, apiKey);
    if (provider === "deepseek") return await answerDeepSeek(prompt, state, apiKey);
    return "Custom provider is selected but not implemented yet.";
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
        model: provider === "openai" ? "gpt-4.1-mini" : "deepseek-chat",
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

export async function inferCompletedPlanTextsWithOptionalCloud(state: AppState, evidence: string): Promise<string[]> {
  const plans = state.plan.map((p) => p.text.trim()).filter(Boolean);
  if (plans.length === 0) return [];
  const { enabled, provider, apiKey } = getConfig();
  if (!enabled || !apiKey.trim()) return [];
  try {
    if (provider === "openai") return await inferCompletedWithOpenAI(state, evidence, apiKey);
    if (provider === "anthropic") return await inferCompletedWithAnthropic(state, evidence, apiKey);
    if (provider === "deepseek") return await inferCompletedWithDeepSeek(state, evidence, apiKey);
    return [];
  } catch {
    return [];
  }
}

function normalizeCompletedTexts(raw: string, planTexts: string[]): string[] {
  const jsonText = extractJsonObject(raw) ?? raw.trim();
  let parsedList: string[] = [];
  try {
    const obj = JSON.parse(jsonText) as Partial<{ completed: string[] }>;
    if (Array.isArray(obj.completed)) parsedList = obj.completed.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    parsedList = [];
  }
  if (!parsedList.length) return [];
  const planByLower = new Map(planTexts.map((x) => [x.toLowerCase(), x]));
  const out: string[] = [];
  for (const item of parsedList) {
    const key = item.toLowerCase();
    if (planByLower.has(key)) out.push(planByLower.get(key) as string);
  }
  return [...new Set(out)];
}

function completedPlanPrompt(state: AppState, evidence: string): string {
  const plans = state.plan.map((p, i) => `${i + 1}. ${p.done ? "[DONE]" : "[TODO]"} ${p.text}`).join("\n");
  return [
    "你是开发进度审计助手。根据代码证据判断哪些计划项已经完成。",
    "要求：仅能从给定计划列表中选择；证据不足则不要猜。",
    "输出必须是 JSON 且仅 JSON。",
    'JSON schema: {"completed": ["计划原文，必须与列表完全一致"]}',
    "",
    "计划列表：",
    plans,
    "",
    "代码证据：",
    evidence
  ].join("\n");
}

async function inferCompletedWithOpenAI(state: AppState, evidence: string, apiKey: string): Promise<string[]> {
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "You are a strict development progress auditor. Return JSON only." },
      { role: "user", content: completedPlanPrompt(state, evidence) }
    ],
    temperature: 0.1
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  if (!r.ok) return [];
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

async function inferCompletedWithAnthropic(state: AppState, evidence: string, apiKey: string): Promise<string[]> {
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 400,
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
  if (!r.ok) return [];
  const json = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  const raw = json.content?.find((c) => c.type === "text")?.text || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

async function inferCompletedWithDeepSeek(state: AppState, evidence: string, apiKey: string): Promise<string[]> {
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: "你是严格的开发进度审计助手。只可依据证据标记完成项。输出 JSON 且仅 JSON。"
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
  if (!r.ok) return [];
  const json = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = json.choices?.[0]?.message?.content || "";
  return normalizeCompletedTexts(raw, state.plan.map((p) => p.text));
}

function localAnswer(prompt: string, state: AppState): string {
  const p = prompt.toLowerCase();
  const diag = state.diagnostics;
  const topPlan = state.plan.slice(0, 5).map((s) => `- ${s.done ? "[x]" : "[ ]"} ${s.text}`).join("\n");
  const validity = state.validity.state;
  const goal = state.goal.summary || "No goal baseline.";

  if (p.includes("deviation") || prompt.includes("偏离")) {
    return `Deviation: ${Math.round(state.deviation.score01 * 100)}%\nReason: ${state.deviation.rationale}\nGoal: ${goal}`;
  }
  if (p.includes("error") || prompt.includes("报错") || prompt.includes("诊断")) {
    return `Diagnostics summary:\n- errors: ${diag.errors}\n- warnings: ${diag.warnings}\n- info: ${diag.infos}\n- hint: ${diag.hints}\n\nValidity: ${validity}`;
  }
  if (p.includes("next") || prompt.includes("下一步") || prompt.includes("建议")) {
    const suggestions: string[] = [];
    if (diag.errors > 0) suggestions.push("Fix current Errors in Problems panel first (they heavily impact validity/deviation).");
    else if (validity === "failed") suggestions.push("Re-run the build check and inspect build output tail; update build command if needed.");
    else suggestions.push("Add/complete plan steps, then run validity check after each meaningful change.");
    return `Next steps:\n${suggestions.map((s) => `- ${s}`).join("\n")}\n\nGoal:\n- ${goal}\n\nTop plan:\n${topPlan || "(no plan steps yet)"}`;
  }

  return `Current status:\n- goal: ${goal}\n- deviation: ${Math.round(state.deviation.score01 * 100)}% (${state.deviation.rationale})\n- diagnostics: ${diag.errors} errors, ${diag.warnings} warnings\n- validity: ${validity}\n\nAsk me about "errors", "deviation", or "next steps".`;
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
  if (state.validity.state === "failed") score = Math.min(score, 0.25);
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
  const score = Math.max(0, Math.min(1, state.deviation.score01));
  const level: AssessmentResult["level"] = score < 0.45 ? "critical" : score < 0.75 ? "warn" : "ok";
  return {
    source: "llm",
    progress,
    deviationScore01: score,
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
  "deviationScore01": "number, 0-1",
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
    "4) 语言使用中文。",
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
      { role: "system", content: "You are a code supervision evaluator. Return JSON only." },
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
        content: "你是项目监理助手。你必须基于代码证据评估进度和偏离。输出 JSON 且仅 JSON。"
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

async function answerOpenAI(prompt: string, state: AppState, apiKey: string): Promise<string> {
  // Minimal call (no tool calling). We keep payload small: high-level signals only.
  const body = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a VS Code assistant focused on development progress, goal deviation, and code validity. Be concise and actionable."
      },
      {
        role: "user",
        content: [
          "User question:",
          prompt,
          "",
          "Current signals:",
          `- goal: ${state.goal.title} | ${state.goal.summary}`,
          `- deviation: ${Math.round(state.deviation.score01 * 100)}% (${state.deviation.rationale})`,
          `- diagnostics: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`,
          `- validity: ${state.validity.state}`,
          `- monitor: ${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `- planSteps: ${state.plan.slice(0, 10).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`).join(" | ") || "(none)"}`,
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

async function answerAnthropic(prompt: string, state: AppState, apiKey: string): Promise<string> {
  const body = {
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: [
          "You are a VS Code assistant focused on development progress, goal deviation, and code validity.",
          "",
          "User question:",
          prompt,
          "",
          "Current signals:",
          `Goal: ${state.goal.title} | ${state.goal.summary}`,
          `Deviation: ${Math.round(state.deviation.score01 * 100)}% (${state.deviation.rationale})`,
          `Diagnostics: ${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings`,
          `Validity: ${state.validity.state}`,
          `Monitor: ${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `Plan: ${state.plan.slice(0, 10).map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`).join(" | ") || "(none)"}`
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

async function answerDeepSeek(prompt: string, state: AppState, apiKey: string): Promise<string> {
  // DeepSeek 提供 OpenAI 兼容接口，这里按 chat/completions 调用
  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content:
          "你是一个代码开发进度监理助手。必须围绕'用户目标-当前证据-下一步动作'回答。禁止空泛口号；若证据不足必须明确写出'证据不足'并要求补充可验证信号（代码改动/构建/测试/计划）。发现可能AI兜圈子时要明确提出异议。"
      },
      {
        role: "user",
        content: [
          "用户问题：",
          prompt,
          "",
          "当前信号：",
          `- 目标基线：${state.goal.title} | ${state.goal.summary}`,
          `- 目标/偏离说明：${Math.round(state.deviation.score01 * 100)}% (${state.deviation.rationale})`,
          `- 诊断：${state.diagnostics.errors} errors, ${state.diagnostics.warnings} warnings, ${state.diagnostics.infos} info, ${state.diagnostics.hints} hints`,
          `- 有效性（构建）：${state.validity.state}`,
          `- 监理告警：${state.monitor.level} | ${state.monitor.reasons.join(" / ")}`,
          `- 计划步骤（前 10 条）：`,
          state.plan
            .slice(0, 10)
            .map((s, i) => `${i + 1}. ${s.done ? "[已完成]" : "[未完成]"} ${s.text}`)
            .join("\n") || "(暂无计划)",
          "",
          "请你基于以上信息，用 4~7 条要点说明：",
          "1）当前实现与目标/计划的偏差（必须引用上面的信号，不要猜）；",
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

