# AI Dev Progress Coach (VS Code Extension)

This is a minimal MVP extension that shows:

- a **sidebar dashboard** (progress signals, plan steps, chat, timeline)
- **code validity** checks via a configurable build command
- **diagnostics** summary from VS Code Problems
- a first-pass **goal deviation score** (heuristic; plan-driven)

## Run (development)

```bash
npm install
npm run build
```

Then press **F5** (launch config: `Run Extension`) to open an *Extension Development Host* window.

Open the sidebar: **AI Dev Coach** activity bar icon → **Progress**.

## Commands

- `AI Dev Coach: Open Sidebar`
- `AI Dev Coach: Add Plan Step`
- `AI Dev Coach: Run Validity Check`
- `AI Dev Coach: Import Baseline From goal.md/plan.md`

If `goal.md` and `plan.md` exist in workspace root, the extension imports and watches them as baseline sources first.

## Settings

- `aiDevCoach.validity.buildCommand` (default: empty, auto-infer from scripts)
- `aiDevCoach.validity.testCommand` (default: empty, optional auto-infer)
- `aiDevCoach.validity.runTestAfterBuild` (default: `false`)
- `aiDevCoach.validity.cwd` (default: workspace root)
- `aiDevCoach.cloud.enabled` (default: false)
- `aiDevCoach.cloud.provider` (`openai` / `anthropic` / `custom`)
- `aiDevCoach.cloud.apiKey`

> Cloud calls are optional. If disabled, chat uses local heuristics based on current signals.

