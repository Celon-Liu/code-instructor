import type {
  AppState,
  ChatMessage,
  DeviationSummary,
  DiagnosticsSummary,
  GoalSummary,
  LlmRefreshStatus,
  MonitorAlert,
  MonitorRuntime,
  PlanStep,
  ProjectAssessment,
  TimelineEvent,
  ValidityStatus
} from "./types";

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class StateStore {
  private state: AppState;
  private listeners = new Set<(s: AppState) => void>();
  private readonly maxEvents: number;

  constructor(maxEvents: number) {
    this.maxEvents = maxEvents;
    this.state = {
      timeline: [],
      plan: [],
      goal: {
        title: "No goal",
        summary: "Import conversation/plan to establish project goal baseline.",
        objectives: [],
        source: "none",
        updatedAt: Date.now()
      },
      diagnostics: { errors: 0, warnings: 0, infos: 0, hints: 0 },
      validity: { state: "idle" },
      deviation: { score01: 0.5, rationale: "No goal/plan baseline yet." },
      monitor: {
        loopRisk: false,
        level: "warn",
        reasons: ["Goal baseline missing."],
        nextActions: ["Import goal from conversation export or set manually."]
      },
      monitorRuntime: {
        engaged: false,
        handling: false,
        realtime: false,
        state: "not_started",
        detail: "Goal baseline missing."
      },
      llmRefresh: {
        state: "idle",
        updatedAt: Date.now()
      },
      assessment: {
        source: "heuristic",
        updatedAt: Date.now(),
        progress: "No executable progress evidence yet.",
        deviationScore01: 0.5,
        deviationRationale: "No goal/plan baseline yet.",
        level: "warn",
        alerts: ["Goal baseline missing."],
        nextActions: ["Import goal from conversation export or set manually."],
        buildCheckMeaning: "Build check verifies whether your configured (or inferred) build command can pass, with optional post-build test."
      },
      chat: []
    };
  }

  subscribe(fn: (s: AppState) => void) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  snapshot(): AppState {
    return JSON.parse(JSON.stringify(this.state)) as AppState;
  }

  hydrate(persisted: { goal?: GoalSummary; plan?: PlanStep[] }) {
    if (persisted.goal) this.state.goal = persisted.goal;
    if (persisted.plan) this.state.plan = persisted.plan;
    this.recomputeDeviation();
    this.emit();
  }

  persistentSnapshot(): { goal: GoalSummary; plan: PlanStep[] } {
    return {
      goal: this.state.goal,
      plan: this.state.plan
    };
  }

  private emit() {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  pushTimeline(type: TimelineEvent["type"], summary: string, detail?: string) {
    const ev: TimelineEvent = { id: uid("ev"), ts: Date.now(), type, summary, detail };
    this.state.timeline.unshift(ev);
    if (this.state.timeline.length > this.maxEvents) this.state.timeline.length = this.maxEvents;
    this.emit();
  }

  setDiagnostics(diag: DiagnosticsSummary) {
    this.state.diagnostics = diag;
    this.recomputeDeviation();
    this.emit();
  }

  setValidity(v: ValidityStatus) {
    this.state.validity = v;
    this.recomputeDeviation();
    this.emit();
  }

  addPlanStep(text: string) {
    const step: PlanStep = { id: uid("plan"), ts: Date.now(), text, done: false };
    this.state.plan.unshift(step);
    this.pushTimeline("plan/step/added", `Plan step added: ${text}`);
    this.recomputeDeviation();
    this.emit();
    return step;
  }

  addPlanSteps(texts: string[]) {
    const cleaned = texts.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length === 0) return 0;
    for (const t of cleaned) this.addPlanStep(t);
    return cleaned.length;
  }

  setPlan(steps: Array<{ text: string; done?: boolean; group?: string; evidencePaths?: string[] }>) {
    const cleaned = steps
      .map((s) => ({
        text: (s.text || "").trim(),
        done: Boolean(s.done),
        group: (s.group || "").trim() || undefined,
        evidencePaths: Array.isArray(s.evidencePaths) ? [...new Set(s.evidencePaths.map((p) => String(p).trim()).filter(Boolean))] : []
      }))
      .filter((s) => s.text.length > 0);
    this.state.plan = cleaned.map((s) => ({
      id: uid("plan"),
      ts: Date.now(),
      text: s.text,
      done: s.done,
      superseded: false,
      group: s.group,
      evidencePaths: s.evidencePaths
    }));
    this.recomputeDeviation();
    this.emit();
    return this.state.plan.length;
  }

  refreshPlanEvidencePaths(workspaceFiles: string[]) {
    const all = [...new Set(workspaceFiles.map((x) => x.trim()).filter(Boolean))];
    if (!all.length || !this.state.plan.length) return 0;

    const keywordBuckets: Array<{ keys: RegExp; preferred: RegExp[] }> = [
      { keys: /监控|monitor|runtime|状态|评估/i, preferred: [/src\/state\.ts$/i, /src\/sidebarView\.ts$/i, /media\/sidebar\.js$/i, /src\/extension\.ts$/i] },
      { keys: /构建|build|compile|validity|测试|test/i, preferred: [/src\/validity\.ts$/i, /src\/extension\.ts$/i] },
      { keys: /指导员|chat|llm|对话|assistant/i, preferred: [/src\/llm\.ts$/i, /src\/extension\.ts$/i, /src\/sidebarView\.ts$/i, /media\/sidebar\.js$/i] },
      { keys: /导入|baseline|goal|plan|ingest/i, preferred: [/src\/ingest\.ts$/i, /src\/extension\.ts$/i, /goal\.md$/i, /plan\.md$/i] },
      { keys: /ui|样式|主题|webview|看板/i, preferred: [/media\/sidebar\.js$/i, /src\/sidebarView\.ts$/i, /media\/icon\.svg$/i] }
    ];

    const pickByPreferred = (preferred: RegExp[]) =>
      all.filter((f) => preferred.some((r) => r.test(f))).slice(0, 3);

    let changed = 0;
    for (const step of this.state.plan) {
      const cur = step.evidencePaths ?? [];
      let next: string[] = [];

      const bucket = keywordBuckets.find((b) => b.keys.test(step.text));
      if (bucket) next = pickByPreferred(bucket.preferred);

      // Fallback: token overlap with filenames (English/identifiers)
      if (!next.length) {
        const tokens = step.text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
        if (tokens.length) {
          const scored = all
            .map((f) => {
              const lf = f.toLowerCase();
              const score = tokens.reduce((acc, t) => (lf.includes(t) ? acc + 1 : acc), 0);
              return { f, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((x) => x.f);
          next = scored;
        }
      }
      // Fallback for Chinese/generic: extract 2-4 char segments and match path
      if (!next.length && step.text.length >= 2) {
        const segments = new Set<string>();
        const normalized = step.text.replace(/\s+/g, "");
        for (let len = 4; len >= 2 && segments.size < 8; len--) {
          for (let i = 0; i <= normalized.length - len; i++) {
            const seg = normalized.slice(i, i + len);
            if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(seg)) segments.add(seg);
          }
        }
        if (segments.size > 0) {
          const scored = all
            .map((f) => {
              const score = [...segments].filter((s) => f.includes(s)).length;
              return { f, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((x) => x.f);
          next = scored;
        }
      }

      const same = cur.length === next.length && cur.every((x, i) => x === next[i]);
      if (!same) {
        step.evidencePaths = next;
        changed++;
      }
    }

    if (changed > 0) this.emit();
    return changed;
  }

  setGoal(goal: Omit<GoalSummary, "updatedAt">) {
    this.state.goal = { ...goal, updatedAt: Date.now() };
    this.pushTimeline("plan/step/added", `Goal updated from ${goal.source}: ${goal.title || "Untitled goal"}`);
    this.recomputeDeviation();
    this.emit();
  }

  markPlanDoneByTexts(texts: string[]) {
    if (!texts.length) return 0;
    const wanted = new Set(texts.map((t) => t.trim().toLowerCase()).filter(Boolean));
    let changed = 0;
    for (const step of this.state.plan) {
      if (step.done) continue;
      if (wanted.has(step.text.trim().toLowerCase())) {
        step.done = true;
        changed++;
      }
    }
    if (changed > 0) {
      this.recomputeDeviation();
      this.emit();
    }
    return changed;
  }

  syncPlanDoneByTexts(texts: string[]) {
    const wanted = new Set(texts.map((t) => t.trim().toLowerCase()).filter(Boolean));
    let changed = 0;
    for (const step of this.state.plan) {
      const shouldDone = wanted.has(step.text.trim().toLowerCase());
      if (step.done !== shouldDone) {
        step.done = shouldDone;
        changed++;
      }
    }
    if (changed > 0) {
      this.recomputeDeviation();
      this.emit();
    }
    return changed;
  }

  /** Sync plan status from LLM inference only. No manual override. */
  syncPlanStatuses(doneTexts: string[], supersededTexts: string[]) {
    const doneSet = new Set(doneTexts.map((t) => t.trim().toLowerCase()).filter(Boolean));
    const supersededSet = new Set(supersededTexts.map((t) => t.trim().toLowerCase()).filter(Boolean));
    let changed = 0;
    for (const step of this.state.plan) {
      const key = step.text.trim().toLowerCase();
      const nextSuperseded = supersededSet.has(key);
      const nextDone = nextSuperseded ? false : doneSet.has(key);
      if (step.done !== nextDone || Boolean(step.superseded) !== nextSuperseded) {
        step.done = nextDone;
        step.superseded = nextSuperseded;
        changed++;
      }
    }
    if (changed > 0) {
      this.recomputeDeviation();
      this.emit();
    }
    return changed;
  }

  setDeviation(d: DeviationSummary) {
    this.state.deviation = d;
    this.emit();
  }

  setLlmRefresh(next: Partial<LlmRefreshStatus> & Pick<LlmRefreshStatus, "state">) {
    this.state.llmRefresh = {
      ...this.state.llmRefresh,
      note: "",
      ...next,
      updatedAt: Date.now()
    };
    this.emit();
  }

  applyProjectAssessment(assessment: Omit<ProjectAssessment, "updatedAt"> & { updatedAt?: number }) {
    const next: ProjectAssessment = {
      ...assessment,
      updatedAt: assessment.updatedAt ?? Date.now()
    };
    this.state.assessment = next;
    this.state.deviation = {
      score01: next.deviationScore01,
      rationale: next.deviationRationale
    };
    const nextMonitor: MonitorAlert = {
      loopRisk: next.level !== "ok" && next.alerts.some((x) => /loop|兜圈|空对空/i.test(x)),
      level: next.level,
      reasons: [...new Set(next.alerts)].slice(0, 6),
      nextActions: [...new Set(next.nextActions)].slice(0, 6)
    };
    this.state.monitorRuntime = this.computeMonitorRuntime();
    this.state.monitor = this.reconcileMonitorAlert(nextMonitor, this.state.monitorRuntime);
    this.emit();
  }

  private reconcileMonitorAlert(alert: MonitorAlert, runtime: MonitorRuntime): MonitorAlert {
    const hasGoal = this.state.goal.source !== "none" && this.state.goal.summary.trim().length > 0;
    const hasPlan = this.state.plan.length > 0;
    const reasons = [...alert.reasons];
    const nextActions = [...alert.nextActions];

    const dropPatterns: RegExp[] = [];
    if (hasGoal) dropPatterns.push(/goal baseline missing|原始目标基线缺失|缺少目标基线/i);
    if (hasPlan) dropPatterns.push(/no executable plan baseline|缺少可执行计划|没有可执行的计划基线/i);
    const filteredReasons = reasons.filter((r) => !dropPatterns.some((p) => p.test(r)));

    if (!hasGoal && !filteredReasons.some((r) => /goal baseline missing|目标基线/i.test(r))) {
      filteredReasons.unshift("Goal baseline missing.");
      nextActions.unshift("Import goal baseline from goal.md or clipboard.");
    }
    if (!hasPlan && !filteredReasons.some((r) => /plan baseline|执行计划|计划基线/i.test(r))) {
      filteredReasons.unshift("No executable plan baseline.");
      nextActions.unshift("Import plan baseline from plan.md.");
    }

    if (runtime.state === "active" && filteredReasons.length === 0) {
      filteredReasons.push("Development signals look healthy.");
    }
    if (runtime.state === "lagging" && !filteredReasons.some((r) => /lagging|滞后/i.test(r))) {
      filteredReasons.push("Monitoring feedback is lagging behind recent development signals.");
      nextActions.unshift("Use Force refresh to sync latest evidence.");
    }

    const levelFromRuntime: MonitorAlert["level"] =
      runtime.state === "blocked" ? "critical" : runtime.state === "lagging" ? "warn" : alert.level;

    return {
      loopRisk: alert.loopRisk,
      level: levelFromRuntime,
      reasons: [...new Set(filteredReasons)].slice(0, 6),
      nextActions: [...new Set(nextActions)].slice(0, 6)
    };
  }

  addChat(role: ChatMessage["role"], text: string) {
    const msg: ChatMessage = { id: uid("chat"), ts: Date.now(), role, text };
    this.state.chat.push(msg);
    this.pushTimeline(role === "user" ? "chat/user" : "chat/assistant", `${role}: ${text.slice(0, 80)}`);
    this.recomputeDeviation();
    this.emit();
    return msg;
  }

  private recomputeDeviation() {
    const hasPlan = this.state.plan.length > 0;
    const hasGoal = this.state.goal.source !== "none" && this.state.goal.summary.trim().length > 0;
    const { errors, warnings } = this.state.diagnostics;
    const doneCount = this.state.plan.filter((p) => p.done).length;
    const supersededCount = this.state.plan.filter((p) => Boolean(p.superseded)).length;
    const effectiveDone = doneCount + supersededCount;
    const coverage = hasPlan ? effectiveDone / Math.max(1, this.state.plan.length) : 0;

    let score = 0.55 + coverage * 0.25;
    if (!hasGoal) score -= 0.2;
    if (!hasPlan) score -= 0.2;
    if (errors > 0) score -= 0.5;
    if (warnings > 0) score -= Math.min(0.2, warnings * 0.02);
    if (this.state.validity.state === "failed") score -= 0.3;
    if (this.state.validity.state === "running") score -= 0.05;

    const monitorRuntime = this.computeMonitorRuntime();
    const monitor = this.computeMonitorAlerts(monitorRuntime);
    if (monitor.level === "warn") score -= 0.08;
    if (monitor.level === "critical") score -= 0.18;

    score = Math.max(0, Math.min(1, score));
    const deviationScore = 1 - score;

    const rationaleParts = [
      `Goal: ${hasGoal ? "set" : "missing"}`,
      `Plan: ${doneCount} done + ${supersededCount} superseded / ${this.state.plan.length}`,
      `Diagnostics: ${errors} errors, ${warnings} warnings`,
      `Build: ${this.state.validity.state}`,
      `Monitor: ${monitor.level}${monitor.loopRisk ? " (loop risk)" : ""} / ${monitorRuntime.state}`
    ];
    const rationale = rationaleParts.join(" | ");
    this.state.deviation = { score01: deviationScore, rationale };
    this.state.monitor = monitor;
    this.state.monitorRuntime = monitorRuntime;
    this.state.assessment = {
      source: "heuristic",
      updatedAt: Date.now(),
      progress: `Plan completion ${doneCount} done + ${supersededCount} superseded / ${this.state.plan.length}; diagnostics ${errors} error(s), ${warnings} warning(s); build ${this.state.validity.state}; monitor ${monitorRuntime.state}.`,
      deviationScore01: deviationScore,
      deviationRationale: rationale,
      level: monitor.level,
      alerts: monitor.reasons,
      nextActions: monitor.nextActions,
      buildCheckMeaning: "Build check verifies whether your configured (or inferred) build command can pass, with optional post-build test."
    };
  }

  private computeMonitorRuntime(): MonitorRuntime {
    const now = Date.now();
    const hasGoal = this.state.goal.source !== "none" && this.state.goal.summary.trim().length > 0;
    const hasPlan = this.state.plan.length > 0;
    const engaged = hasGoal && hasPlan;
    const latestEdit = this.state.timeline.find((t) => t.type === "document/changed" || t.type === "document/saved");
    const latestAssessment = this.state.timeline.find((t) => t.type === "analysis/updated");
    const blocked = this.state.diagnostics.errors > 0;
    const handling = this.state.validity.state === "running" || Boolean(latestAssessment && now - latestAssessment.ts <= 8 * 60 * 1000);
    const editAgeMs = latestEdit ? now - latestEdit.ts : Infinity;
    const assessmentAfterEdit = Boolean(latestAssessment && latestAssessment.ts >= (latestEdit?.ts ?? 0) && latestAssessment.ts - (latestEdit?.ts ?? 0) <= 180 * 1000);
    const noRecentEdits = editAgeMs > 5 * 60 * 1000;
    const realtime: boolean = latestEdit
      ? (assessmentAfterEdit || (noRecentEdits && handling) || Boolean(handling && latestAssessment && now - latestAssessment.ts <= 2 * 60 * 1000))
      : handling;

    if (!hasGoal) {
      return {
        engaged: false,
        handling,
        realtime: false,
        state: "not_started",
        detail: "Goal baseline missing."
      };
    }
    if (blocked) {
      return {
        engaged,
        handling,
        realtime,
        state: "blocked",
        detail: "Blocked by unresolved errors. Fix in Problems panel and re-run Build Check."
      };
    }
    if (engaged && handling && realtime) {
      return {
        engaged: true,
        handling: true,
        realtime: true,
        state: "active",
        detail: "Monitoring fully engaged with real-time feedback."
      };
    }
    return {
      engaged,
      handling,
      realtime,
      state: "lagging",
      detail: "Monitoring partially engaged; feedback is lagging."
    };
  }

  private computeMonitorAlerts(runtime: MonitorRuntime): MonitorAlert {
    const reasons: string[] = [];
    const nextActions: string[] = [];
    let level: MonitorAlert["level"] = "ok";
    let loopRisk = false;

    const latestEdit = this.state.timeline.find((t) => t.type === "document/changed" || t.type === "document/saved");
    const latestUserChat = [...this.state.chat].reverse().find((m) => m.role === "user");
    const latestAssistantChat = [...this.state.chat].reverse().find((m) => m.role === "assistant");

    if (!this.state.plan.length) {
      level = "warn";
      reasons.push("No executable plan baseline.");
      nextActions.push("Create or import 3-5 concrete plan steps.");
    }
    if (this.state.goal.source === "none") {
      level = "warn";
      reasons.push("Original goal baseline missing.");
      nextActions.push("Import conversation export to extract goal summary.");
    }
    if (this.state.diagnostics.errors > 0) {
      level = "critical";
      reasons.push(`${this.state.diagnostics.errors} unresolved error diagnostics.`);
      nextActions.push("Fix first error in Problems panel, then re-run Build Check to unblock.");
    }
    if (runtime.state === "lagging") {
      level = level === "critical" ? "critical" : "warn";
      reasons.push("Monitoring feedback is lagging behind recent development signals.");
      nextActions.push("Save current files or run self-check to force evidence refresh.");
    }
    if (this.state.plan.length > 0) {
      const effectiveDone = this.state.plan.filter((p) => p.done || p.superseded).length;
      const hasRecentEdits = Boolean(latestEdit && Date.now() - latestEdit.ts < 30 * 60 * 1000);
      if (effectiveDone === 0 && hasRecentEdits) {
        level = level === "critical" ? "critical" : "warn";
        reasons.push("Plan progress is 0 but recent code edits exist; mapping evidence may be insufficient.");
        nextActions.push("Run self-check or Force refresh to re-evaluate; enable cloud LLM for automatic plan completion.");
      }
    }

    if (latestUserChat && latestAssistantChat) {
      const elapsedNoEditMs = latestEdit ? Date.now() - latestEdit.ts : Number.POSITIVE_INFINITY;
      const chatGap = Math.abs(latestAssistantChat.ts - latestUserChat.ts);
      if (elapsedNoEditMs > 10 * 60 * 1000 && chatGap < 5 * 60 * 1000 && this.state.chat.length >= 6) {
        loopRisk = true;
        level = "warn";
        reasons.push("High chat activity but no recent code change (possible AI loop).");
        nextActions.push("Force concrete action: modify code, run build, or add measurable task.");
      }
    }

    if (!reasons.length) {
      reasons.push("Development signals look healthy.");
      nextActions.push("Continue with next planned step and run validation.");
    }

    // Keep concise and non-redundant
    const dedup = (arr: string[]) => [...new Set(arr)].slice(0, 4);
    return {
      loopRisk,
      level,
      reasons: dedup(reasons),
      nextActions: dedup(nextActions)
    };
  }
}

