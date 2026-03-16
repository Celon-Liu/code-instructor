export type TimelineEventType =
  | "workspace/opened"
  | "document/opened"
  | "document/changed"
  | "document/saved"
  | "diagnostics/changed"
  | "validity/build/started"
  | "validity/build/succeeded"
  | "validity/build/failed"
  | "validity/test/started"
  | "validity/test/succeeded"
  | "validity/test/failed"
  | "validity/test/skipped"
  | "selfcheck/run"
  | "analysis/updated"
  | "plan/step/added"
  | "goal/baseline/imported"
  | "plan/baseline/imported"
  | "chat/user"
  | "chat/assistant";

export type TimelineEvent = {
  id: string;
  ts: number;
  type: TimelineEventType;
  summary: string;
  detail?: string;
};

export type PlanStep = {
  id: string;
  ts: number;
  text: string;
  done: boolean;
};

export type ValidityStatus =
  | { state: "idle" }
  | { state: "running"; startedAt: number; command: string }
  | { state: "passed"; finishedAt: number; command: string; durationMs: number }
  | { state: "failed"; finishedAt: number; command: string; durationMs: number; exitCode: number; tail: string };

export type DiagnosticsSummary = {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
};

export type DeviationSummary = {
  score01: number;
  rationale: string;
};

export type GoalSummary = {
  title: string;
  summary: string;
  objectives: string[];
  source: string;
  updatedAt: number;
};

export type MonitorAlert = {
  loopRisk: boolean;
  level: "ok" | "warn" | "critical";
  reasons: string[];
  nextActions: string[];
};

export type ChatMessage = {
  id: string;
  ts: number;
  role: "user" | "assistant";
  text: string;
};

export type ProjectAssessment = {
  source: "heuristic" | "llm";
  updatedAt: number;
  progress: string;
  deviationScore01: number;
  deviationRationale: string;
  level: "ok" | "warn" | "critical";
  alerts: string[];
  nextActions: string[];
  buildCheckMeaning: string;
};

export type AppState = {
  timeline: TimelineEvent[];
  plan: PlanStep[];
  goal: GoalSummary;
  diagnostics: DiagnosticsSummary;
  validity: ValidityStatus;
  deviation: DeviationSummary;
  monitor: MonitorAlert;
  assessment: ProjectAssessment;
  chat: ChatMessage[];
};
