/**
 * Regression tests for code coach (代码指导员) chat send and Chinese display.
 * Run: npm run test
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { StateStore } from "./state";

describe("chat send (代码指导员)", () => {
  it("addChat adds user and assistant messages with correct structure", () => {
    const store = new StateStore(100);
    const userMsg = store.addChat("user", "现在进度如何");
    const assistantMsg = store.addChat("assistant", "当前计划完成率 72%，偏离度 73%。");

    assert.strictEqual(userMsg.role, "user");
    assert.strictEqual(userMsg.text, "现在进度如何");
    assert.ok(userMsg.id && userMsg.ts);

    assert.strictEqual(assistantMsg.role, "assistant");
    assert.strictEqual(assistantMsg.text, "当前计划完成率 72%，偏离度 73%。");
    assert.ok(assistantMsg.id && assistantMsg.ts);

    const state = store.snapshot();
    assert.strictEqual(state.chat.length, 2);
    assert.strictEqual(state.chat[0]?.role, "user");
    assert.strictEqual(state.chat[1]?.role, "assistant");
  });

  it("chat messages are valid for display (role + non-empty text)", () => {
    const store = new StateStore(100);
    store.addChat("user", "偏离点是什么");
    store.addChat("assistant", "主要偏差在于计划完成度，7 项未完成。");

    const state = store.snapshot();
    for (const m of state.chat) {
      assert.ok(m.role === "user" || m.role === "assistant");
      assert.ok(typeof m.text === "string" && m.text.length > 0);
    }
  });

  it("assistant response with Chinese text is stored correctly", () => {
    const store = new StateStore(100);
    const zhResponse =
      "当前实现与目标/计划的偏差：计划完成率 72%，偏离度 73%。接下来建议执行 UI 微调和回归测试。";
    store.addChat("assistant", zhResponse);

    const state = store.snapshot();
    const last = state.chat[state.chat.length - 1];
    assert.ok(last);
    assert.strictEqual(last!.role, "assistant");
    assert.ok(/[\u4e00-\u9fff]/.test(last!.text), "response should contain Chinese");
    assert.strictEqual(last!.text, zhResponse);
  });
});
