/**
 * Regression test: 点击"导入目标"可成功从 goal.md 导入有效目标文本
 * Run: npm run test
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractGoalSummary } from "./ingest";
import { StateStore } from "./state";

const goalMdPath = join(__dirname, "../goal.md");

describe("import goal from goal.md", () => {
  it("extractGoalSummary parses goal.md content successfully", () => {
    const raw = readFileSync(goalMdPath, "utf-8");
    const goal = extractGoalSummary(raw);
    assert.ok(goal, "should extract goal from goal.md");
    assert.ok(goal!.title.length > 0, "title should be non-empty");
    assert.ok(goal!.summary.length > 0, "summary should be non-empty");
    assert.ok(Array.isArray(goal!.objectives));
  });

  it("extractGoalSummary returns undefined for empty content (triggers manual input path)", () => {
    assert.strictEqual(extractGoalSummary(""), undefined);
    assert.strictEqual(extractGoalSummary("   \n\t  "), undefined);
  });

  it("setGoal with workspace-goal.md produces valid imported state", () => {
    const raw = readFileSync(goalMdPath, "utf-8");
    const goal = extractGoalSummary(raw);
    assert.ok(goal);

    const store = new StateStore(100);
    store.setGoal({
      title: goal!.title,
      summary: goal!.summary,
      objectives: goal!.objectives,
      source: "workspace-goal.md"
    });

    const s = store.snapshot();
    assert.strictEqual(s.goal.source, "workspace-goal.md");
    assert.ok(s.goal.title.length > 0);
    assert.ok(s.goal.summary.length > 0);
    assert.ok(s.goal.summary.trim().length > 0, "imported state should have non-empty summary");
  });
});
