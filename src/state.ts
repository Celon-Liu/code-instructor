import type { AppState, ChatMessage, DeviationSummary, DiagnosticsSummary, GoalSummary, MonitorAlert, PlanStep, ProjectAssessment, TimelineEvent, ValidityStatus } from "./types";

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

  setPlan(steps: Array<{ text: string; done?: boolean }>) {
    const cleaned = steps
      .map((s) => ({ text: (s.text || "").trim(), done: Boolean(s.done) }))
      .filter((s) => s.text.length > 0);
    this.state.plan = cleaned.map((s) => ({
      id: uid("plan"),
      ts: Date.now(),
      text: s.text,
      done: s.done
    }));
    this.recomputeDeviation();
    this.emit();
    return this.state.plan.length;
  }

  setGoal(goal: Omit<GoalSummary, "updatedAt">) {
    this.state.goal = { ...goal, updatedAt: Date.now() };
    this.pushTimeline("plan/step/added", `Goal updated from ${goal.source}: ${goal.title || "Untitled goal"}`);
    this.recomputeDeviation();
    this.emit();
  }

  togglePlanDone(id: string) {
    const step = this.state.plan.find((s) => s.id === id);
    if (!step) return;
    step.done = !step.done;
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

  setDeviation(d: DeviationSummary) {
    this.state.deviation = d;
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
    this.state.monitor = {
      loopRisk: next.level !== "ok" && next.alerts.some((x) => /loop|兜圈|空对空/i.test(x)),
      level: next.level,
      reasons: [...new Set(next.alerts)].slice(0, 6),
      nextActions: [...new Set(next.nextActions)].slice(0, 6)
    };
    this.emit();
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
    const coverage = hasPlan ? doneCount / Math.max(1, this.state.plan.length) : 0;

    let score = 0.55 + coverage * 0.25;
    if (!hasGoal) score -= 0.2;
    if (!hasPlan) score -= 0.2;
    if (errors > 0) score -= 0.5;
    if (warnings > 0) score -= Math.min(0.2, warnings * 0.02);
    if (this.state.validity.state === "failed") score -= 0.3;
    if (this.state.validity.state === "running") score -= 0.05;

    const monitor = this.computeMonitorAlerts();
    if (monitor.level === "warn") score -= 0.08;
    if (monitor.level === "critical") score -= 0.18;

    score = Math.max(0, Math.min(1, score));

    const rationaleParts = [
      `Goal: ${hasGoal ? "set" : "missing"}`,
      `Plan: ${doneCount}/${this.state.plan.length} done`,
      `Diagnostics: ${errors} errors, ${warnings} warnings`,
      `Build: ${this.state.validity.state}`,
      `Monitor: ${monitor.level}${monitor.loopRisk ? " (loop risk)" : ""}`
    ];
    const rationale = rationaleParts.join(" | ");
    this.state.deviation = { score01: score, rationale };
    this.state.monitor = monitor;
    this.state.assessment = {
      source: "heuristic",
      updatedAt: Date.now(),
      progress: `Plan completion ${doneCount}/${this.state.plan.length}; diagnostics ${errors} error(s), ${warnings} warning(s); build ${this.state.validity.state}.`,
      deviationScore01: score,
      deviationRationale: rationale,
      level: monitor.level,
      alerts: monitor.reasons,
      nextActions: monitor.nextActions,
      buildCheckMeaning: "Build check verifies whether your configured (or inferred) build command can pass, with optional post-build test."
    };
  }

  private computeMonitorAlerts(): MonitorAlert {
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
      nextActions.push("Fix first error in Problems panel and rerun validity check.");
    }
    if (this.state.validity.state === "failed") {
      level = "critical";
      reasons.push("Latest build validity check failed.");
      nextActions.push("Address build failure tail and rerun check.");
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

