import * as vscode from "vscode";
import { summarizeDiagnostics } from "./diagnostics";
import { answerWithOptionalCloud, assessProjectWithOptionalCloud, inferCompletedPlanTextsWithOptionalCloud, summarizeGoalFromText } from "./llm";
import { SidebarViewProvider } from "./sidebarView";
import { StateStore } from "./state";
import { resolveBuildCommand, resolveTestCommand, runCommand } from "./validity";
import { extractGoalSummary, extractPlanItems, extractPlanSteps } from "./ingest";
import { extractConversationText, findStorageCandidates } from "./cursorStorage";
import { connectTraeExportFlow } from "./traeExport";
import { buildProjectEvidence } from "./projectContext";

export function activate(context: vscode.ExtensionContext) {
  const maxEvents = vscode.workspace.getConfiguration("aiDevCoach").get<number>("telemetry.maxEvents", 500);
  const store = new StateStore(maxEvents);
  store.pushTimeline("workspace/opened", "Workspace opened");

  const sidebar = new SidebarViewProvider(context.extensionUri, store);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebar));
  context.subscriptions.push(sidebar);

  const persistState = () => {
    void context.globalState.update("aiDevCoach.persist.v1", store.persistentSnapshot());
  };
  const unSubPersist = store.subscribe(() => persistState());
  context.subscriptions.push(new vscode.Disposable(unSubPersist));

  let assessTimer: ReturnType<typeof setTimeout> | undefined;
  let assessRunning = false;
  let lastAssessAt = 0;
  const scheduleProjectAssessment = (reason: string) => {
    const cfg = vscode.workspace.getConfiguration("aiDevCoach");
    if (!cfg.get<boolean>("cloud.enabled", false)) return;
    if (!cfg.get<string>("cloud.apiKey", "").trim()) return;
    if (assessTimer) clearTimeout(assessTimer);
    assessTimer = setTimeout(() => {
      void runProjectAssessment(reason);
    }, 2500);
  };
  const runProjectAssessment = async (reason: string) => {
    if (assessRunning) return;
    if (Date.now() - lastAssessAt < 15000) return;
    assessRunning = true;
    try {
      const state = store.snapshot();
      const evidence = await buildProjectEvidence(state);
      const assessed = await assessProjectWithOptionalCloud(state, evidence);
      store.applyProjectAssessment(assessed);
      const completedByLlm = await inferCompletedPlanTextsWithOptionalCloud(store.snapshot(), evidence);
      if (completedByLlm.length > 0) {
        const changed = store.markPlanDoneByTexts(completedByLlm);
        if (changed > 0) {
          store.pushTimeline("plan/step/added", `LLM auto-marked ${changed} plan step(s) as done.`);
        }
      }
      store.pushTimeline("analysis/updated", `Project assessment updated (${assessed.source}) [${reason}]`);
      lastAssessAt = Date.now();
    } catch {
      // fall back silently; heuristics remain active
    } finally {
      assessRunning = false;
    }
  };

  const generatePlanFromGoal = () => {
    const s = store.snapshot();
    const g = s.goal;
    if (g.source === "none") return 0;
    const noisePattern =
      /(self-check|no executable plan baseline|create or import .*plan|development signals look healthy|continue with next planned step|diagnostics|validity|loop risk|\[pass\]|\[warn\]|\[fail\])/i;
    const candidate = g.objectives.length
      ? g.objectives.slice(0, 5)
      : g.summary.split(/[。.!?；;]/).map((x) => x.trim()).filter(Boolean).slice(0, 4);
    const templated = candidate
      .filter((x) => !noisePattern.test(x))
      .filter((x) => x.length >= 8)
      .map((x) => x.replace(/^[-*\d.\s]+/, "").trim())
      .map((x) => x.length > 56 ? `${x.slice(0, 56)}...` : x)
      .map((x, i) => `任务${i + 1}: ${x}`);
    return store.addPlanSteps(templated);
  };

  const isZh = (vscode.env.language || "").toLowerCase().startsWith("zh");
  let preferWorkspaceBaselines = false;
  const looksLikeProjectGoalText = (text: string) => {
    const t = text.trim();
    if (!t || t.length < 16) return false;
    const lower = t.toLowerCase();
    const hasGoalWords =
      /目标|需求|计划|项目|插件|监控|进度|偏离|代码指导员|goal|plan|project|plugin|monitor|progress|deviation/.test(lower);
    const hasManySeparators = (t.match(/[。.!?；;\n]/g) || []).length >= 1;
    const codeLikeDensity = (t.match(/[{}();=<>\[\]]/g) || []).length / Math.max(1, t.length);
    const filePathLike = /(^|[\s"'])[\w\-./]+\.(ts|tsx|js|jsx|json|md|yaml|yml)([\s"']|$)/i.test(t);
    if (codeLikeDensity > 0.07 || filePathLike) return false;
    return hasGoalWords || hasManySeparators;
  };

  const ingestFromText = (raw: string, source: string) => {
    const isAutoExternalSource = /^(cursor-storage|cursor-storage-scan|trae-export|plan-file)/.test(source);
    if (preferWorkspaceBaselines && isAutoExternalSource) {
      return { stepCount: 0, hasGoal: false, generatedFromGoal: false };
    }
    const steps = extractPlanSteps(raw);
    const goal = extractGoalSummary(raw);
    const stepCount = store.addPlanSteps(steps);
    if (goal) {
      store.setGoal({
        title: goal.title,
        summary: goal.summary,
        objectives: goal.objectives,
        source
      });
    }
    if (stepCount === 0 && goal) {
      const generated = generatePlanFromGoal();
      scheduleProjectAssessment(`ingest-${source}`);
      return { stepCount: generated, hasGoal: true, generatedFromGoal: generated > 0 };
    }
    if (stepCount > 0 || goal) scheduleProjectAssessment(`ingest-${source}`);
    return { stepCount, hasGoal: Boolean(goal), generatedFromGoal: false };
  };

  const baselineGoalFile = "goal.md";
  const baselinePlanFile = "plan.md";
  const readWorkspaceRootFile = async (fileName: string): Promise<string | undefined> => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return undefined;
    const uri = vscode.Uri.joinPath(ws.uri, fileName);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return undefined;
    }
  };
  const importWorkspaceBaselines = async (reason: string, silent = false) => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      if (!silent) void vscode.window.showWarningMessage("AI Dev Coach: no workspace folder open.");
      return { hasGoal: false, planCount: 0 };
    }
    const goalRaw = await readWorkspaceRootFile(baselineGoalFile);
    const planRaw = await readWorkspaceRootFile(baselinePlanFile);
    let hasGoal = false;
    let planCount = 0;

    if (goalRaw) {
      const goal = extractGoalSummary(goalRaw);
      if (goal) {
        store.setGoal({
          title: goal.title,
          summary: goal.summary,
          objectives: goal.objectives,
          source: "workspace-goal.md"
        });
        hasGoal = true;
      }
    }
    if (planRaw) {
      const items = extractPlanItems(planRaw);
      if (items.length > 0) {
        planCount = store.setPlan(items);
      }
    }

    if (hasGoal) store.pushTimeline("goal/baseline/imported", `Imported goal baseline from ${baselineGoalFile}`);
    if (planCount > 0) store.pushTimeline("plan/baseline/imported", `Imported ${planCount} plan steps from ${baselinePlanFile}`);
    if (hasGoal || planCount > 0) scheduleProjectAssessment(reason);
    preferWorkspaceBaselines = hasGoal || planCount > 0;
    if (!silent) {
      if (hasGoal || planCount > 0) {
        void vscode.window.showInformationMessage(
          `AI Dev Coach: imported baseline from workspace files (goal: ${hasGoal ? "yes" : "no"}, plan: ${planCount} step(s)).`
        );
      } else {
        void vscode.window.showWarningMessage("AI Dev Coach: no valid baseline found in goal.md / plan.md.");
      }
    }
    return { hasGoal, planCount };
  };

  const refreshDiagnostics = () => {
    store.setDiagnostics(summarizeDiagnostics());
    store.pushTimeline("diagnostics/changed", "Diagnostics updated");
    scheduleProjectAssessment("diagnostics");
  };

  // Initial signals
  refreshDiagnostics();
  void importWorkspaceBaselines("workspace-baseline-startup", true);
  scheduleProjectAssessment("startup");

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      refreshDiagnostics();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      store.pushTimeline("document/opened", `Opened: ${vscode.workspace.asRelativePath(doc.uri)}`);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      store.pushTimeline("document/changed", `Changed: ${vscode.workspace.asRelativePath(e.document.uri)}`);
      scheduleProjectAssessment("document-changed");
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file") return;
      store.pushTimeline("document/saved", `Saved: ${vscode.workspace.asRelativePath(doc.uri)}`);
      scheduleProjectAssessment("document-saved");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.openSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.aiDevCoach");
      sidebar.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.addPlanStep", async () => {
      const text = await vscode.window.showInputBox({
        title: "Add plan step",
        prompt: "Paste a step from the AI plan (used to score deviation).",
        ignoreFocusOut: true
      });
      if (!text?.trim()) return;
      store.addPlanStep(text.trim());
      scheduleProjectAssessment("plan-step-added");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.ingestPlanFromClipboard", async () => {
      const raw = await vscode.env.clipboard.readText();
      const r = ingestFromText(raw, "clipboard");
      store.pushTimeline("plan/step/added", `Ingested ${r.stepCount} plan steps from clipboard`);
      void vscode.window.showInformationMessage(
        `AI Dev Coach: imported ${r.stepCount} plan steps${r.hasGoal ? " + goal baseline" : ""}${r.generatedFromGoal ? " (auto-generated from goal)" : ""}.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.setGoalFromClipboard", async () => {
      const baselineImported = await importWorkspaceBaselines("goal-imported", true);
      if (baselineImported.hasGoal || baselineImported.planCount > 0) {
        void vscode.window.showInformationMessage(
          isZh
            ? `AI Dev Coach：已从工作区基线文件导入（goal.md: ${baselineImported.hasGoal ? "是" : "否"}，plan.md: ${baselineImported.planCount} 条）。`
            : `AI Dev Coach: imported from workspace baseline files (goal.md: ${baselineImported.hasGoal ? "yes" : "no"}, plan.md: ${baselineImported.planCount} step(s)).`
        );
        return;
      }

      const clipboardRaw = await vscode.env.clipboard.readText();
      let raw = clipboardRaw;
      let goal = looksLikeProjectGoalText(raw) ? extractGoalSummary(raw) : undefined;

      if (!goal) {
        const pasted = await vscode.window.showInputBox({
          title: isZh ? "导入目标基线" : "Import goal baseline",
          prompt: isZh
            ? "剪贴板内容不像完整项目目标，请粘贴项目目标/会话文本。"
            : "Clipboard does not look like a full project goal. Paste project goal/conversation text here.",
          value: raw ?? "",
          ignoreFocusOut: true
        });
        if (!pasted?.trim()) {
          void vscode.window.showWarningMessage(
            isZh
              ? "AI Dev Coach：已取消导入目标（未提供文本）。"
              : "AI Dev Coach: goal import cancelled (no text provided)."
          );
          return;
        }
        raw = pasted;
        goal = extractGoalSummary(raw);
      }

      if (!goal) {
        // Try LLM-based summarization as a fallback for conversational/colloquial text.
        const llmGoal = await summarizeGoalFromText(raw);
        if (!llmGoal) {
          void vscode.window.showWarningMessage(
            isZh
              ? "AI Dev Coach：无法从提供文本中解析目标基线（LLM 梳理后仍失败）。"
              : "AI Dev Coach: unable to parse goal baseline from provided text (even after LLM summarization)."
          );
          store.addChat(
            "assistant",
            isZh
              ? "目标导入失败：未识别到可用目标基线，且 LLM 梳理后仍未得到可用摘要。"
              : "Goal import failed: no recognizable goal baseline found, and LLM summarization also did not return a usable summary."
          );
          return;
        }
        goal = llmGoal;
      }
      store.setGoal({
        title: goal.title,
        summary: goal.summary,
        objectives: goal.objectives,
        source: "clipboard-or-manual"
      });
      const snap = store.snapshot();
      let gen = 0;
      if (snap.plan.length === 0) gen = generatePlanFromGoal();
      scheduleProjectAssessment("goal-imported");
      store.addChat(
        "assistant",
        isZh
          ? `目标导入成功：${goal.title}\n${gen > 0 ? `已基于目标基线自动生成 ${gen} 条计划步骤。` : "计划保持不变。"}`
          : `Goal imported successfully: ${goal.title}\n${gen > 0 ? `Auto-generated ${gen} plan steps from goal baseline.` : "Plan kept unchanged."}`
      );
      void vscode.window.showInformationMessage(
        isZh
          ? `AI Dev Coach：已更新目标基线${gen > 0 ? `，并生成 ${gen} 条计划步骤` : ""}。`
          : `AI Dev Coach: goal baseline updated from clipboard${gen > 0 ? `, and ${gen} plan steps generated` : ""}.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.generatePlanFromGoal", async () => {
      const n = generatePlanFromGoal();
      if (n > 0) scheduleProjectAssessment("plan-generated-from-goal");
      if (n > 0) {
        void vscode.window.showInformationMessage(`AI Dev Coach: generated ${n} plan steps from goal baseline.`);
      } else {
        void vscode.window.showWarningMessage("AI Dev Coach: no clean actionable goal items found to generate plan.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.importWorkspaceBaselines", async () => {
      await importWorkspaceBaselines("workspace-baseline-command");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.inspectHostCommands", async () => {
      const all = await vscode.commands.getCommands(true);
      const interesting = all
        .filter((c) => /cursor|trae|ai|chat|copilot|assistant|model/i.test(c))
        .sort((a, b) => a.localeCompare(b));

      const out = vscode.window.createOutputChannel("AI Dev Coach");
      out.show(true);
      out.appendLine(`Total commands: ${all.length}`);
      out.appendLine(`Interesting commands: ${interesting.length}`);
      out.appendLine("");
      for (const c of interesting) out.appendLine(c);

      await vscode.env.clipboard.writeText(interesting.join("\n"));
      void vscode.window.showInformationMessage("AI Dev Coach: command list copied to clipboard (filtered).");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.runSelfCheck", async () => {
      const cfg = vscode.workspace.getConfiguration("aiDevCoach");
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const state = store.snapshot();
      const lines: string[] = [];
      let pass = 0;
      let warn = 0;
      let fail = 0;

      const add = (level: "PASS" | "WARN" | "FAIL", item: string, detail: string) => {
        if (level === "PASS") pass++;
        if (level === "WARN") warn++;
        if (level === "FAIL") fail++;
        lines.push(`[${level}] ${item}: ${detail}`);
      };

      // 1) Workspace
      if (ws) add("PASS", "Workspace", ws);
      else add("FAIL", "Workspace", "No workspace folder open.");

      // 2) Goal baseline
      if (state.goal.source !== "none" && state.goal.summary.trim()) {
        add("PASS", "Goal baseline", `${state.goal.title} (${state.goal.source})`);
      } else {
        add("FAIL", "Goal baseline", "Missing. Import from conversation or clipboard.");
      }

      // 3) Plan baseline
      if (state.plan.length >= 3) {
        const done = state.plan.filter((p) => p.done).length;
        add("PASS", "Plan baseline", `${done}/${state.plan.length} steps done.`);
      } else if (state.plan.length > 0) {
        add("WARN", "Plan baseline", `Only ${state.plan.length} step(s). Recommend at least 3.`);
      } else {
        add("FAIL", "Plan baseline", "No plan steps.");
      }

      // 4) Build command validity
      const cwd = cfg.get<string>("validity.cwd", "") || undefined;
      const buildResolved = await resolveBuildCommand(cfg.get<string>("validity.buildCommand", ""), cwd);
      if (buildResolved.source === "configured") {
        add("PASS", "Build command", `${buildResolved.command} (configured)`);
      } else if (buildResolved.source === "inferred") {
        add(
          "WARN",
          "Build command",
          `${buildResolved.command} (auto-inferred from script "${buildResolved.scriptName || "unknown"}")`
        );
      } else {
        add("WARN", "Build command", `${buildResolved.command} (fallback default; recommend explicit configuration)`);
      }

      // 4.5) Optional test command validity
      const runTestAfterBuild = cfg.get<boolean>("validity.runTestAfterBuild", false);
      const testConfigured = cfg.get<string>("validity.testCommand", "");
      if (!runTestAfterBuild) {
        add("WARN", "Post-build test", "Disabled. Enable validity.runTestAfterBuild to add smoke-test gating.");
      } else {
        const testResolved = await resolveTestCommand(testConfigured, cwd);
        if (!testResolved) {
          add("FAIL", "Post-build test", "Enabled but no test command available (configure validity.testCommand).");
        } else if (testResolved.source === "configured") {
          add("PASS", "Post-build test", `${testResolved.command} (configured)`);
        } else {
          add(
            "WARN",
            "Post-build test",
            `${testResolved.command} (auto-inferred from script "${testResolved.scriptName || "unknown"}")`
          );
        }
      }

      // 5) Cloud LLM config
      const cloudEnabled = cfg.get<boolean>("cloud.enabled", false);
      const provider = cfg.get<string>("cloud.provider", "deepseek");
      const key = cfg.get<string>("cloud.apiKey", "");
      if (!cloudEnabled) {
        add("WARN", "Cloud LLM", "Disabled. Local fallback only.");
      } else if (!key.trim()) {
        add("FAIL", "Cloud LLM", `Enabled (${provider}) but API key missing.`);
      } else {
        add("PASS", "Cloud LLM", `Enabled (${provider}) with API key configured.`);
      }

      // 6) Current runtime health
      if (state.diagnostics.errors > 0) {
        add("FAIL", "Diagnostics", `${state.diagnostics.errors} error(s), ${state.diagnostics.warnings} warning(s).`);
      } else if (state.diagnostics.warnings > 0) {
        add("WARN", "Diagnostics", `0 errors, ${state.diagnostics.warnings} warning(s).`);
      } else {
        add("PASS", "Diagnostics", "No current errors/warnings.");
      }

      if (state.validity.state === "failed") add("FAIL", "Validity", "Last build check failed.");
      else if (state.validity.state === "idle") add("WARN", "Validity", "No build check run yet.");
      else if (state.validity.state === "running") add("WARN", "Validity", "Build check running.");
      else add("PASS", "Validity", "Last build check passed.");

      if (state.monitor.loopRisk) add("WARN", "Loop risk", "Potential AI looping detected.");
      else add("PASS", "Loop risk", "No loop risk detected.");

      const summary = `Self-check: ${pass} pass, ${warn} warn, ${fail} fail`;
      const out = vscode.window.createOutputChannel("AI Dev Coach");
      out.show(true);
      out.appendLine(summary);
      out.appendLine("");
      for (const l of lines) out.appendLine(l);

      store.pushTimeline("selfcheck/run", summary, lines.join("\n"));
      store.addChat("assistant", `${summary}\n${lines.map((l) => `- ${l}`).join("\n")}`);

      if (fail > 0) void vscode.window.showWarningMessage(`AI Dev Coach: ${summary}`);
      else void vscode.window.showInformationMessage(`AI Dev Coach: ${summary}`);
    })
  );

  let cursorStorageWatcher: vscode.FileSystemWatcher | undefined;
  const startCursorStorageWatch = (dirPath: string) => {
    cursorStorageWatcher?.dispose();
    if (!dirPath.trim()) return;
    cursorStorageWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirPath, "**/*"));
    context.subscriptions.push(cursorStorageWatcher);

    const onAny = async (uri: vscode.Uri) => {
      const text = await extractConversationText(uri);
      if (!text) return;
      const r = ingestFromText(text, "cursor-storage");
      const n = r.stepCount;
      if (n > 0) store.pushTimeline("plan/step/added", `Ingested ${n} plan steps from Cursor storage: ${uri.path.split("/").pop()}`);
    };
    cursorStorageWatcher.onDidChange((u) => void onAny(u));
    cursorStorageWatcher.onDidCreate((u) => void onAny(u));
  };

  // Auto-start watcher if configured
  const configuredCursorDir = vscode.workspace.getConfiguration("aiDevCoach").get<string>("ingest.cursorChatStorageDir", "") || "";
  if (configuredCursorDir.trim()) startCursorStorageWatch(configuredCursorDir);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.connectCursorChatStorage", async () => {
      // Open the host storage folder to help the user locate it (if supported)
      try {
        await vscode.commands.executeCommand("workbench.action.chat.openStorageFolder");
      } catch {
        // ignore if not supported
      }

      const picked = await vscode.window.showOpenDialog({
        title: "Select Cursor chat storage directory (experimental)",
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      });
      const dir = picked?.[0];
      if (!dir) return;

      await vscode.workspace.getConfiguration("aiDevCoach").update("ingest.cursorChatStorageDir", dir.fsPath, vscode.ConfigurationTarget.Global);
      startCursorStorageWatch(dir.fsPath);

      const out = vscode.window.createOutputChannel("AI Dev Coach");
      out.show(true);
      out.appendLine(`Scanning: ${dir.fsPath}`);

      const candidates = await findStorageCandidates(dir, 4, 1500);
      out.appendLine(`Found ${candidates.length} candidate files (by extension).`);

      let imported = 0;
      let scanned = 0;
      for (const c of candidates) {
        scanned++;
        const text = await extractConversationText(c.uri);
        if (!text) continue;
        const n = ingestFromText(text, "cursor-storage-scan").stepCount;
        if (n > 0) {
          imported += n;
          store.pushTimeline("plan/step/added", `Ingested ${n} plan steps from Cursor storage scan: ${c.uri.path.split("/").pop()}`);
        }
        if (scanned >= 300) break; // keep MVP bounded
      }

      void vscode.window.showInformationMessage(`AI Dev Coach: Cursor storage connected. Imported ${imported} plan steps.`);
    })
  );

  // Trae: export-based ingestion (recommended)
  let traeExportWatcher: vscode.FileSystemWatcher | undefined;
  const startTraeExportWatch = (pathOrDir: string) => {
    traeExportWatcher?.dispose();
    if (!pathOrDir.trim()) return;
    const isDirGuess = !pathOrDir.includes(".") && !pathOrDir.endsWith(".json") && !pathOrDir.endsWith(".md") && !pathOrDir.endsWith(".jsonl") && !pathOrDir.endsWith(".txt");
    traeExportWatcher = isDirGuess
      ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(pathOrDir, "**/*"))
      : vscode.workspace.createFileSystemWatcher(pathOrDir);
    context.subscriptions.push(traeExportWatcher);

    const tryIngest = async (uri: vscode.Uri) => {
      const text = await extractConversationText(uri);
      if (!text) return;
      const n = ingestFromText(text, "trae-export").stepCount;
      if (n > 0) store.pushTimeline("plan/step/added", `Ingested ${n} plan steps from Trae export: ${uri.path.split("/").pop()}`);
    };
    traeExportWatcher.onDidChange((u) => void tryIngest(u));
    traeExportWatcher.onDidCreate((u) => void tryIngest(u));
  };

  const configuredTraePath = vscode.workspace.getConfiguration("aiDevCoach").get<string>("ingest.traeSessionExportPath", "") || "";
  if (configuredTraePath.trim()) startTraeExportWatch(configuredTraePath);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.connectTraeSessionExport", async () => {
      const r = await connectTraeExportFlow();
      if (!r.ok) {
        void vscode.window.showWarningMessage(`AI Dev Coach: ${r.note}`);
        return;
      }

      await vscode.workspace
        .getConfiguration("aiDevCoach")
        .update("ingest.traeSessionExportPath", r.exportPath, vscode.ConfigurationTarget.Global);

      startTraeExportWatch(r.exportPath);
      store.pushTimeline("plan/step/added", "Connected Trae session export");
      void vscode.window.showInformationMessage("AI Dev Coach: Trae export connected. I will auto-import plan steps when exports change.");
    })
  );

  // Optional: watch a plan file and auto-ingest updates
  const setupPlanFileWatcher = () => {
    const cfg = vscode.workspace.getConfiguration("aiDevCoach");
    const p = (cfg.get<string>("ingest.planFilePath", "") || "").trim();
    if (!p) return undefined;
    const uri = vscode.Uri.file(p);
    const watcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
    const ingest = async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = Buffer.from(bytes).toString("utf8");
        const n = ingestFromText(raw, "plan-file").stepCount;
        if (n > 0) store.pushTimeline("plan/step/added", `Ingested ${n} plan steps from plan file`);
      } catch {
        // ignore
      }
    };
    void ingest();
    watcher.onDidChange(() => void ingest());
    watcher.onDidCreate(() => void ingest());
    return watcher;
  };
  const planWatcher = setupPlanFileWatcher();
  if (planWatcher) context.subscriptions.push(planWatcher);

  // Watch workspace root baseline files: goal.md / plan.md
  const setupWorkspaceBaselineWatchers = () => {
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) return [];
    const goalWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, baselineGoalFile));
    const planWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, baselinePlanFile));
    const refresh = () => void importWorkspaceBaselines("workspace-baseline-updated", true);
    goalWatcher.onDidCreate(refresh);
    goalWatcher.onDidChange(refresh);
    planWatcher.onDidCreate(refresh);
    planWatcher.onDidChange(refresh);
    return [goalWatcher, planWatcher];
  };
  for (const w of setupWorkspaceBaselineWatchers()) context.subscriptions.push(w);

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.runValidityCheck", async () => {
      const cfg = vscode.workspace.getConfiguration("aiDevCoach");
      const cwd = cfg.get<string>("validity.cwd", "") || undefined;
      const runTestAfterBuild = cfg.get<boolean>("validity.runTestAfterBuild", false);
      const buildResolved = await resolveBuildCommand(cfg.get<string>("validity.buildCommand", ""), cwd);
      const command = buildResolved.command;

      store.setValidity({ state: "running", startedAt: Date.now(), command });
      const buildSourceNote =
        buildResolved.source === "configured"
          ? "configured"
          : buildResolved.source === "inferred"
            ? `auto-inferred from ${buildResolved.scriptName || "script"}`
            : "fallback default";
      store.pushTimeline("validity/build/started", `Build check started: ${command} (${buildSourceNote})`);

      const r = await runCommand(command, cwd, 10 * 60 * 1000);
      if (r.ok) {
        if (runTestAfterBuild) {
          const testResolved = await resolveTestCommand(cfg.get<string>("validity.testCommand", ""), cwd);
          if (!testResolved) {
            const tail = "Post-build test is enabled, but no test command was configured or inferred from package scripts.";
            store.setValidity({
              state: "failed",
              finishedAt: Date.now(),
              command,
              durationMs: r.durationMs,
              exitCode: 2,
              tail
            });
            store.pushTimeline("validity/test/skipped", "Build passed, but test stage is blocked (missing test command).", tail);
            void vscode.window.showWarningMessage(
              "AI Dev Coach: build passed but post-build test is enabled without a test command."
            );
            scheduleProjectAssessment("build-check-failed");
            return;
          }

          const testSourceNote =
            testResolved.source === "configured"
              ? "configured"
              : testResolved.source === "inferred"
                ? `auto-inferred from ${testResolved.scriptName || "script"}`
                : "default";
          store.pushTimeline("validity/test/started", `Post-build test started: ${testResolved.command} (${testSourceNote})`);
          const tr = await runCommand(testResolved.command, cwd, 10 * 60 * 1000);
          if (!tr.ok) {
            const tail = [tr.stderr, tr.stdout].filter(Boolean).join("\n").slice(-6000);
            store.setValidity({
              state: "failed",
              finishedAt: Date.now(),
              command: `${command} && ${testResolved.command}`,
              durationMs: r.durationMs + tr.durationMs,
              exitCode: tr.exitCode,
              tail
            });
            store.pushTimeline("validity/test/failed", `Post-build test failed (code ${tr.exitCode})`, tail);
            void vscode.window.showWarningMessage(`AI Dev Coach: post-build test failed (exit ${tr.exitCode}).`);
            scheduleProjectAssessment("build-check-failed");
            return;
          }
          store.pushTimeline("validity/test/succeeded", `Post-build test passed (${tr.durationMs}ms)`);
          store.setValidity({
            state: "passed",
            finishedAt: Date.now(),
            command: `${command} && ${testResolved.command}`,
            durationMs: r.durationMs + tr.durationMs
          });
          store.pushTimeline("validity/build/succeeded", `Build + test check passed (${r.durationMs + tr.durationMs}ms)`);
          scheduleProjectAssessment("build-check-passed");
          return;
        }

        store.setValidity({
          state: "passed",
          finishedAt: Date.now(),
          command,
          durationMs: r.durationMs
        });
        store.pushTimeline("validity/build/succeeded", `Build check passed (${r.durationMs}ms)`);
        scheduleProjectAssessment("build-check-passed");
      } else {
        const tail = [r.stderr, r.stdout].filter(Boolean).join("\n").slice(-6000);
        store.setValidity({
          state: "failed",
          finishedAt: Date.now(),
          command,
          durationMs: r.durationMs,
          exitCode: r.exitCode,
          tail
        });
        store.pushTimeline("validity/build/failed", `Build check failed (code ${r.exitCode})`, tail);
        void vscode.window.showWarningMessage(`AI Dev Coach: build check failed (exit ${r.exitCode}).`);
        scheduleProjectAssessment("build-check-failed");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.openBuildDetail", async () => {
      const snap = store.snapshot();
      const v = snap.validity;
      const out = vscode.window.createOutputChannel("AI Dev Coach Build Detail");
      out.show(true);
      out.appendLine(`state: ${v.state}`);
      if ("command" in v) out.appendLine(`command: ${v.command}`);
      if ("durationMs" in v) out.appendLine(`durationMs: ${v.durationMs}`);
      if ("exitCode" in v) out.appendLine(`exitCode: ${v.exitCode}`);
      out.appendLine("");
      if (v.state === "failed" && "tail" in v && v.tail) out.appendLine(v.tail);
      else out.appendLine("No build failure tail available. Run a build check to refresh details.");
    })
  );

  // Internal command used by the webview to send chat
  context.subscriptions.push(
    vscode.commands.registerCommand("aiDevCoach.chatSend", async (text: string) => {
      store.addChat("user", text);
      const state = store.snapshot();
      const answer = await answerWithOptionalCloud(text, state);
      store.addChat("assistant", answer);
      scheduleProjectAssessment("chat");
    })
  );
}

export function deactivate() {
  // no-op
}

