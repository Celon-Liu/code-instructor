# Code Instructor

A VS Code / Cursor extension for AI-assisted coding: real-time development progress, goal deviation tracking, and code validity checks.

## Features

- **Sidebar Dashboard** — Progress signals, plan steps, chat assistant, and event timeline
- **Goal & Plan Baseline** — Import from `goal.md` / `plan.md` or clipboard
- **Deviation Score** — Heuristic + optional LLM-based assessment
- **Build Validity Check** — Configurable build/test commands
- **Code Instructor Chat** — Q&A about current goal, plan, and progress

## Installation

### From VS Code Marketplace

1. Open VS Code or Cursor
2. Press `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (macOS) to open Extensions
3. Search for **Code Instructor**
4. Click **Install**

### From VSIX (local)

1. Download the `.vsix` file from [Releases](https://github.com/Celon-Liu/code-instructor/releases)
2. Press `Ctrl+Shift+P` / `Cmd+Shift+P` → **Extensions: Install from VSIX...**
3. Select the downloaded `.vsix` file

## Quick Start

### 1. Open the sidebar

Click the **Code Instructor** icon in the left activity bar, or run the command **Code Instructor: Open Sidebar**.

### 2. Import goal and plan

**Option A — From workspace files (recommended)**

Create two files in your workspace root:

- **`goal.md`** — Project goal with `# Title` and `## User` block for summary
- **`plan.md`** — Execution plan with checkboxes (`- [ ]` / `- [x]`)

The extension auto-imports on startup. Or click **Import goal** to import manually.

**Option B — From clipboard**

1. Copy goal/plan text from a conversation or document
2. Click **Import goal** in the sidebar
3. If clipboard content is invalid, a manual input box will appear

### 3. View progress

After importing, the sidebar shows:

- **Status** — Active / Lagging / Blocked
- **Progress** — Plan completion (e.g. 25/26)
- **Deviation** — Low / Medium / High
- **Validity** — Build check state (idle / running / passed / failed)

### 4. Run build check

Click **Run Check** in the Validity section to run your build command. Configure `aiDevCoach.validity.buildCommand` if needed (default: auto-infer from `package.json` scripts).

### 5. Use Code Instructor chat

Type a question in the chat input and press Enter. The assistant answers based on current goal, plan, and evidence. Cloud LLM is optional (see Settings).

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `aiDevCoach.validity.buildCommand` | Build command for validity check | Auto-infer from scripts |
| `aiDevCoach.validity.testCommand` | Optional test command | Auto-infer |
| `aiDevCoach.validity.runTestAfterBuild` | Run test after build passes | `false` |
| `aiDevCoach.validity.cwd` | Working directory for commands | Workspace root |
| `aiDevCoach.cloud.enabled` | Enable cloud LLM for assessment/chat | `false` |
| `aiDevCoach.cloud.provider` | Provider: `deepseek`, `openai`, `anthropic`, `custom` | `deepseek` |
| `aiDevCoach.cloud.apiKey` | API key for the provider | (empty) |
| `aiDevCoach.ingest.planFilePath` | Custom plan file path | (empty) |

> **Note:** Cloud calls are optional. If disabled, chat uses local heuristics based on current signals.

## Commands

| Command | Description |
|---------|-------------|
| Code Instructor: Open Sidebar | Open the Code Instructor sidebar |
| Code Instructor: Import Baseline From goal.md/plan.md | Import goal and plan from workspace files |
| Code Instructor: Set Goal Baseline From Clipboard | Import goal from clipboard (fallback when files missing) |
| Code Instructor: Import Plan Steps From Clipboard | Import plan steps from clipboard |
| Code Instructor: Run Validity Check | Run build/test check |
| Code Instructor: Add Plan Step | Add a plan step manually |

## Development

```bash
npm install
npm run build
```

Press **F5** to launch the Extension Development Host. Open the sidebar via the Code Instructor icon.

### Run tests

```bash
npm run test
```

## License

MIT License. See [LICENSE](LICENSE) for details.
