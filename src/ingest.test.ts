/**
 * Regression tests for ingest module (plan/goal extraction).
 * Run: npm run test
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { extractPlanItems, extractPlanSteps, extractGoalSummary } from "./ingest";

describe("extractPlanItems", () => {
  it("parses checkboxes and groups from plan.md", () => {
    const raw = `## P0: 基线
- [ ] 步骤一
- [x] 步骤二
## P1: 监控
- [ ] 步骤三`;
    const items = extractPlanItems(raw);
    assert.strictEqual(items.length, 3);
    const a = items[0];
    const b = items[1];
    const c = items[2];
    assert.ok(a && b && c);
    assert.strictEqual(a.text, "步骤一");
    assert.strictEqual(a.done, false);
    assert.strictEqual(a.group, "P0: 基线");
    assert.strictEqual(b.text, "步骤二");
    assert.strictEqual(b.done, true);
    assert.strictEqual(c.group, "P1: 监控");
  });
});

describe("extractPlanSteps", () => {
  it("returns step texts only", () => {
    const raw = `## P0
- [ ] 任务A
- [x] 任务B`;
    const steps = extractPlanSteps(raw);
    assert.deepStrictEqual(steps, ["任务A", "任务B"]);
  });
});

describe("extractGoalSummary", () => {
  it("extracts title and summary from goal text", () => {
    const raw = `# 项目目标
## user
这是用户描述的项目目标，需要实现监控和进度跟踪。`;
    const goal = extractGoalSummary(raw);
    assert.ok(goal);
    assert.strictEqual(goal!.title, "项目目标");
    assert.ok(goal!.summary.includes("用户描述") || goal!.summary.includes("监控"));
  });

  it("returns undefined for empty input", () => {
    assert.strictEqual(extractGoalSummary(""), undefined);
    assert.strictEqual(extractGoalSummary("   \n  "), undefined);
  });
});

describe("import success display (button & goal summary)", () => {
  const isImported = (goal: { source?: string } | null) =>
    Boolean(goal && goal.source && goal.source !== "none");

  const getGoalDisplayLine = (
    goal: { title?: string; summary?: string; objectives?: string[] } | null,
    placeholder: string
  ) => {
    if (!goal) return placeholder;
    const title = (goal.title ?? "").trim();
    const summary = (goal.summary ?? "").trim();
    const firstObjective = (goal.objectives?.[0] ?? "").trim();
    return title && summary ? `${title} - ${summary}` : title || summary || firstObjective || placeholder;
  };

  it("imported=true when goal has source !== none", () => {
    assert.strictEqual(isImported({ source: "workspace-goal.md" }), true);
    assert.strictEqual(isImported({ source: "clipboard" }), true);
  });

  it("imported=false when goal has source none or missing", () => {
    assert.strictEqual(isImported({ source: "none" }), false);
    assert.strictEqual(isImported(null), false);
    assert.strictEqual(isImported({}), false);
  });

  it("goal display line shows title and summary when both present", () => {
    const line = getGoalDisplayLine(
      { title: "项目目标", summary: "实现监控功能" },
      "—"
    );
    assert.strictEqual(line, "项目目标 - 实现监控功能");
  });

  it("goal display line falls back to placeholder when empty", () => {
    assert.strictEqual(getGoalDisplayLine(null, "点击导入"), "点击导入");
    assert.strictEqual(getGoalDisplayLine({ title: "", summary: "", objectives: [] }, "—"), "—");
  });
});
