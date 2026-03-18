# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2025-03-16

### 计划跟踪

- **移除人为进度确认**：计划步骤状态完全由 LLM 基于代码证据判断，不再支持点击切换 todo/done/superseded
- **plan.md 变更检测**：强制刷新或自动刷新时检测 plan.md 是否变化，若变化则自动重新导入计划
- **忽略 plan.md checkbox**：从 plan.md 导入时忽略 `[x]`/`[ ]` 状态，完成度仅由 LLM 推断

### 证据与评估

- **按计划项拆分证据**：每个计划项有独立的代码证据块，LLM 在对应块内查找实现
- **LLM 选择关联文件**：由 LLM 为每个计划项选择关联文件，无固定数量限制（替代原先每项最多 6 个文件）
- **证据扩展**：支持 Python、Go、Rust、Java、Kotlin、C/C++ 等，排除 `__pycache__`、`venv`、`.venv`
- **两阶段流程**：先由 LLM 从 FILE INVENTORY 选出每项相关文件，再构建 CODE SNAPSHOTS 并推断完成度

### 计划与开发联动

- **计划不符弹窗**：当评估为 warn/critical 且告警含计划相关建议时，弹出「计划与代码不符」提示
- **操作选项**：支持「打开 plan.md」「重新导入 goal.md 和 plan.md」「忽略」
- **防打扰**：10 分钟内最多提醒一次，可通过 `aiDevCoach.notify.planMismatchPrompt` 关闭
- **评估提示增强**：当计划与代码不符时，LLM 必须在 nextActions/alerts 中建议「更新 plan.md」

### 偏离度修正

- **语义统一**：偏离度 0 = 无偏离（好），1 = 严重偏离（坏）
- **颜色逻辑**：0–25% 绿色，25–55% 黄色，>55% 红色（原先逻辑反了，0% 会错误显示红色）
- **Heuristic 与 LLM**：统一使用「偏离度」语义，LLM 提示中明确 `0=无偏离(好) 1=严重偏离(坏)`

### 其他

- 新增配置 `aiDevCoach.notify.planMismatchPrompt`：控制计划不符弹窗
- 文案更新：计划说明改为「LLM 完全基于代码证据判断完成度；计划变更请先改 plan.md，刷新时自动检测并重新导入」

---

[1.0.0]: https://github.com/Celon-Liu/code-instructor/releases/tag/v1.0.0
