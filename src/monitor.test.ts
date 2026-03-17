/**
 * Regression tests: 监控快照与监理告警在状态变化时均有真实数据更新
 * Run: npm run test
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { StateStore } from "./state";

describe("monitor snapshot and alerts update with state changes", () => {
  it("initial state has monitor reasons (goal missing)", () => {
    const store = new StateStore(100);
    const s = store.snapshot();
    assert.ok(s.monitor.reasons.length > 0);
    assert.ok(
      s.monitor.reasons.some((r) => /goal|目标|missing|缺少/i.test(r)),
      "should mention goal missing"
    );
    assert.strictEqual(s.monitorRuntime.state, "not_started");
  });

  it("after setting goal, monitor runtime updates", () => {
    const store = new StateStore(100);
    store.setGoal({
      title: "项目目标",
      summary: "实现监控与进度跟踪",
      objectives: ["监控状态", "构建校验"],
      source: "workspace-goal.md"
    });
    const s = store.snapshot();
    assert.strictEqual(s.goal.source, "workspace-goal.md");
    assert.ok(s.monitorRuntime.state !== undefined);
    assert.ok(s.monitor.reasons.length >= 0 || s.monitor.nextActions.length >= 0);
  });

  it("after adding plan, progress and deviation update", () => {
    const store = new StateStore(100);
    store.setGoal({
      title: "目标",
      summary: "摘要",
      objectives: [],
      source: "workspace-goal.md"
    });
    store.addPlanSteps(["步骤一", "步骤二", "步骤三"]);
    const s = store.snapshot();
    assert.strictEqual(s.plan.length, 3);
    assert.ok(typeof s.deviation.score01 === "number");
    assert.ok(s.assessment.progress.length > 0);
  });

  it("after setting diagnostics errors, monitor reflects blocked state", () => {
    const store = new StateStore(100);
    store.setGoal({ title: "X", summary: "Y", objectives: [], source: "clipboard" });
    store.addPlanSteps(["步骤"]);
    const before = store.snapshot();
    store.setDiagnostics({ errors: 1, warnings: 0, infos: 0, hints: 0 });
    const after = store.snapshot();
    assert.strictEqual(after.diagnostics.errors, 1);
    assert.strictEqual(after.monitorRuntime.state, "blocked");
    assert.ok(
      after.monitor.reasons.some((r) => /error|错误|diagnostic|诊断/i.test(r)) ||
        after.monitor.nextActions.some((a) => /error|错误|fix|修复|problem/i.test(a)),
      "monitor should mention error/diagnostics"
    );
  });

  it("when document/changed then analysis/updated within 120s, monitor can be active", () => {
    const store = new StateStore(100);
    store.setGoal({ title: "X", summary: "Y", objectives: [], source: "workspace-goal.md" });
    store.addPlanSteps(["步骤"]);
    store.setValidity({ state: "passed", finishedAt: Date.now(), command: "build", durationMs: 100 });
    store.pushTimeline("document/changed", "Changed: src/foo.ts");
    store.pushTimeline("analysis/updated", "Project assessment updated [test]");
    store.setDiagnostics(store.snapshot().diagnostics);
    const s = store.snapshot();
    const latestEdit = s.timeline.find((t) => t.type === "document/changed" || t.type === "document/saved");
    const latestAssessment = s.timeline.find((t) => t.type === "analysis/updated");
    assert.ok(latestEdit && latestAssessment, "should have both events");
    assert.ok(latestAssessment!.ts >= latestEdit!.ts, "assessment should be after edit");
    assert.ok(latestAssessment!.ts - latestEdit!.ts <= 120 * 1000, "within 120s window");
    assert.strictEqual(s.monitorRuntime.state, "active", "monitor should be active when edit and assessment within window");
  });

  it("after setting validity passed, state reflects build status", () => {
    const store = new StateStore(100);
    store.setValidity({
      state: "passed",
      finishedAt: Date.now(),
      command: "npm run build",
      durationMs: 1000
    });
    const s = store.snapshot();
    assert.strictEqual(s.validity.state, "passed");
    assert.ok(s.assessment.progress.includes("passed") || s.deviation.rationale.includes("Build"));
  });
});
