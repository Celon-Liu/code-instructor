import * as vscode from "vscode";
import type { AppState } from "./types";
import { StateStore } from "./state";

function nonce() {
  return Math.random().toString(36).slice(2, 12);
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiDevCoach.sidebar";
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;
  private readonly store: StateStore;

  constructor(extensionUri: vscode.Uri, store: StateStore) {
    this.extensionUri = extensionUri;
    this.store = store;
  }

  dispose() {
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.view = webviewView;
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webview.html = this.renderHtml(webview);

    this.disposables.push(
      webview.onDidReceiveMessage(async (msg: unknown) => {
        const m = msg as { type?: string; payload?: unknown };
        try {
          if (m.type === "ui/ready") {
            this.postState();
          }
          if (m.type === "command/runValidityCheck") {
            await vscode.commands.executeCommand("aiDevCoach.runValidityCheck");
          }
          if (m.type === "command/setGoalFromClipboard") {
            await vscode.commands.executeCommand("aiDevCoach.setGoalFromClipboard");
          }
          if (m.type === "command/runSelfCheck") {
            await vscode.commands.executeCommand("aiDevCoach.runSelfCheck");
          }
          if (m.type === "command/openProblems") {
            await vscode.commands.executeCommand("workbench.actions.view.problems");
          }
          if (m.type === "command/openBuildDetail") {
            await vscode.commands.executeCommand("aiDevCoach.openBuildDetail");
          }
          if (m.type === "command/forceRefreshAssessment") {
            await vscode.commands.executeCommand("aiDevCoach.forceRefreshAssessment");
          }
          if (m.type === "command/generatePlanFromGoal") {
            await vscode.commands.executeCommand("aiDevCoach.generatePlanFromGoal");
          }
          if (m.type === "chat/send") {
            const text = (m.payload as { text?: string })?.text?.trim();
            if (!text) return;
            await vscode.commands.executeCommand("aiDevCoach.chatSend", text);
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          void vscode.window.showWarningMessage("AI Dev Coach: webview message handling failed: " + reason);
        }
      })
    );

    const unsub = this.store.subscribe(() => {
      this.postState();
    });
    this.disposables.push(new vscode.Disposable(unsub));

    this.postState();
  }

  reveal() {
    this.view?.show?.(true);
  }

  private postState() {
    if (!this.view) return;
    const state = this.store.snapshot();
    this.view.webview.postMessage({ type: "state", payload: state satisfies AppState });
  }

  private renderHtml(webview: vscode.Webview) {
    const lang = (vscode.env.language || "en").toLowerCase();
    const zh = lang.startsWith("zh");
    const n = nonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${n}' 'unsafe-inline'`
    ].join("; ");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"));

    const i18n = {
      header: zh ? "Code Instructor" : "AI Dev Supervision Board v1",
      llmRefresh: zh ? "LLM 刷新" : "LLM refresh",
      llmIdle: zh ? "空闲" : "idle",
      llmLoading: zh ? "更新中..." : "loading...",
      llmDone: zh ? "已完成" : "done",
      llmError: zh ? "异常" : "error",
      forceRefresh: zh ? "强制刷新" : "Force refresh",
      forceRefreshing: zh ? "刷新中..." : "Refreshing...",
      snapshot: zh ? "监控快照" : "Monitoring Snapshot",
      status: zh ? "监控状态" : "Monitoring Status",
      conclusion: zh ? "当前结论" : "Current Conclusion",
      progress: zh ? "开发进度" : "Progress",
      statusNotStarted: zh ? "未开始监控" : "Not started",
      statusRunning: zh ? "监控进行中" : "Monitoring",
      statusBlocked: zh ? "当前阻塞" : "Blocked",
      statusLagging: zh ? "反馈滞后" : "Lagging feedback",
      msgGoalMissing: zh ? "缺少目标基线。" : "Goal baseline missing.",
      msgPlanMissing: zh ? "已设置目标，但缺少可执行计划。" : "Goal is set but executable plan is missing.",
      msgBuildBlocked: zh ? "监控已开启，但构建校验失败，当前阻塞。" : "Monitoring active, but currently blocked by failed build check.",
      msgErrorBlocked: zh ? "监控已开启，但存在未解决错误，当前阻塞。" : "Monitoring active, but currently blocked by unresolved errors.",
      msgLoopRisk: zh ? "监控已开启；检测到可能 AI 兜圈子（高对话、低代码变更）。" : "Monitoring active; possible AI loop detected (high chat, low code changes).",
      msgHealthy: zh ? "监控已开启，开发信号正在推进。" : "Monitoring active and development signals are moving.",
      msgFallbackNext: zh ? "运行一次自检，并完成下一个计划步骤。" : "Run self-check and complete next plan item.",
      deviation: zh ? "偏离度" : "Deviation",
      validity: zh ? "构建校验" : "Build Check",
      runCheck: zh ? "运行校验" : "Run check",
      goal: zh ? "目标基线" : "Goal Baseline",
      importGoal: zh ? "导入目标" : "Import goal",
      importSuccess: zh ? "成功导入" : "Imported",
      importing: zh ? "导入中..." : "Importing...",
      goalHint: zh ? "点击“导入目标”以开始。" : "Click \"Import goal\" to start.",
      goalPlaceholder: zh ? "点击“导入目标”以开始。" : "Click \"Import goal\" to start.",
      signals: zh ? "实时信号（LLM）" : "Runtime Signals (LLM)",
      errors: zh ? "错误" : "Errors",
      warnings: zh ? "警告" : "Warnings",
      info: zh ? "信息" : "Info",
      hint: zh ? "提示" : "Hint",
      monitor: zh ? "监理告警" : "Monitor Alerts",
      selfCheck: zh ? "运行自检" : "Run self-check",
      plan: zh ? "执行计划" : "Execution Plan",
      planHelp: zh ? "计划状态由 LLM 基于代码证据实时判定并刷新。" : "Plan completion is auto-evaluated and refreshed by LLM from code evidence.",
      noPlanYet: zh ? "暂无计划步骤（导入目标时会读取 plan.md）。" : "No plan steps yet (plan.md is loaded when importing goal baseline).",
      groupDefault: zh ? "未分组" : "Ungrouped",
      chat: zh ? "代码指导员" : "Code Coach",
      chatPlaceholder: zh ? "问：现在偏离点是什么？下一步具体改哪？" : "Ask: what is off-track now? what exact next action?",
      send: zh ? "发送" : "Send",
      chatTip: zh ? "边界控制：证据不足时会提示补充可验证信号。" : "Boundary control: asks for verifiable signals when evidence is insufficient.",
      timeline: zh ? "事件时间线" : "Event Timeline",
      idle: zh ? "空闲" : "idle",
      running: zh ? "运行中" : "running",
      passed: zh ? "通过" : "passed",
      failed: zh ? "失败" : "failed",
      validityMeaningDefault: zh
        ? "构建校验用于检查当前项目是否能通过配置（或自动推断）的构建命令，并可在通过后继续执行测试。"
        : "Build check verifies the project can pass the configured (or inferred) build command, with optional post-build test.",
      levelOk: zh ? "正常" : "ok",
      levelWarn: zh ? "警告" : "warn",
      levelCritical: zh ? "严重" : "critical",
      signalSource: zh ? "评估来源" : "Source",
      signalErrors: zh ? "错误数" : "Errors",
      signalBuild: zh ? "构建状态" : "Build",
      signalAlerts: zh ? "告警条数" : "Alerts",
      signalClickHint: zh ? "点击可跳转" : "Click to jump",
      runtime: zh ? "监控运行态" : "Monitor Runtime",
      runtimeEngaged: zh ? "介入" : "Engaged",
      runtimeHandling: zh ? "处理中" : "Handling",
      runtimeRealtime: zh ? "实时反馈" : "Realtime",
      yes: zh ? "是" : "Yes",
      no: zh ? "否" : "No"
    };

    return /* html */ `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Dev Coach</title>
    <style>
      :root {
        --bg: #f7f8fa;
        --fg: #1f2328;
        --muted: #667085;
        --border: #d0d5dd;
        --panel: #ffffff;
        --panel2: #fbfcfe;
        --chip: #f2f4f7;
        --hover: #f5f8ff;
        --ok: #1d1d1d;
        --warn: #1d1d1d;
        --critical: #1d1d1d;
      }
      body {
        margin: 0;
        padding: 12px;
        background: var(--bg);
        color: var(--fg);
        font: 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .title {
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px 12px;
        margin-bottom: 10px;
        font-weight: 700;
        letter-spacing: 0.2px;
        background: #fff;
      }
      .section {
        border: 1px solid var(--border);
        border-radius: 12px;
        margin-bottom: 10px;
        background: var(--panel);
        box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
        overflow: hidden;
      }
      .section .hd {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
        font-weight: 700;
        background: var(--panel2);
      }
      .section .bd {
        padding: 10px 12px;
      }
      .grid4 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .space { justify-content: space-between; }
      .chip {
        border: 1px solid var(--border);
        background: var(--chip);
        border-radius: 999px;
        padding: 2px 6px;
        font-size: 11px;
      }
      .kpi {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      .pill {
        border: 1px solid var(--border);
        background: #fff;
        border-radius: 10px;
        padding: 7px 8px;
      }
      .signalCard { cursor: pointer; user-select: none; }
      .signalCard:hover { background: var(--hover); }
      .signalV { margin-top: 3px; font-weight: 700; }
      .signalHint { margin-top: 3px; color: var(--muted); font-size: 11px; }
      .runtimeGrid {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
        margin-top: 6px;
      }
      .runtimeItem {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        padding: 6px 8px;
      }
      .runtimeLabel { font-size: 11px; color: var(--muted); }
      .runtimeVal { margin-top: 2px; font-weight: 700; }
      .result {
        border: 1px solid var(--border);
        background: #fff;
        border-radius: 10px;
        padding: 7px 8px;
      }
      .result .k { font-size: 11px; color: var(--muted); }
      .result .v { margin-top: 3px; font-weight: 650; }
      .state-good { background: #e7f6ec; border: 1px solid #9ed0ac; color: #1f5f2a; border-radius: 999px; padding: 2px 8px; display: inline-block; }
      .state-warn { background: #fff7e7; border: 1px solid #ebca8a; color: #7a5600; border-radius: 999px; padding: 2px 8px; display: inline-block; }
      .state-bad { background: #feeceb; border: 1px solid #efb1ad; color: #8b1e1e; border-radius: 999px; padding: 2px 8px; display: inline-block; }
      button {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fff;
        color: var(--fg);
        padding: 6px 10px;
        cursor: pointer;
      }
      button:hover { background: var(--hover); }
      button.primary {
        background: #2f6feb;
        border-color: #2f6feb;
        color: #fff;
      }
      .btn-success {
        background: #2e7d32 !important;
        border-color: #2e7d32 !important;
        color: #fff !important;
      }
      .list { display: flex; flex-direction: column; gap: 6px; }
      .item {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 7px 8px;
        background: #fff;
      }
      .item .meta { color: var(--muted); font-size: 11px; margin-top: 4px; }
      .planItem { display: flex; gap: 8px; align-items: flex-start; }
      .planItem input { margin-top: 2px; }
      .planItem .text { flex: 1; }
      .planItem.done .text { text-decoration: line-through; color: var(--muted); }
      .planEntry {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 7px 8px;
        background: #fff;
      }
      .planGroup {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fff;
        overflow: hidden;
      }
      .planGroupSummary {
        cursor: pointer;
        padding: 7px 10px;
        background: var(--panel2);
        font-weight: 700;
        border-bottom: 1px solid var(--border);
      }
      .planGroupBody {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .planEntryRow { display: flex; align-items: flex-start; gap: 8px; }
      .planIconTodo { color: var(--muted); }
      .planIconDone { color: #2e7d32; }
      .planTextDone { color: #2e7d32; text-decoration: line-through; }
      .chat {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 190px;
        overflow: auto;
        padding-right: 4px;
      }
      .bubble {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 7px 8px;
        max-width: 92%;
        white-space: pre-wrap;
        background: #fff;
      }
      .bubble.user { margin-left: auto; }
      .bubble.assistant { margin-right: auto; }
      .chatBar { display: flex; gap: 8px; margin-top: 8px; }
      .chatBar input {
        flex: 1;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 7px 8px;
        background: #fff;
        color: var(--fg);
      }
      .small { color: var(--muted); font-size: 11px; margin-top: 4px; }
      .goalText {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fff;
        padding: 7px 8px;
        cursor: pointer;
        white-space: pre-wrap;
      }
      .goalText.oneLine {
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .planText {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fff;
        padding: 7px 8px;
        cursor: pointer;
        white-space: pre-wrap;
      }
      .planText.oneLine {
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .level-ok, .level-warn, .level-critical { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; display: inline-block; }
      .level-ok { background: #e7f6ec; border-color: #9ed0ac; color: #1f5f2a; }
      .level-warn { background: #fff7e7; border-color: #ebca8a; color: #7a5600; }
      .level-critical { background: #feeceb; border-color: #efb1ad; color: #8b1e1e; }
      .alertTicker {
        margin-top: 6px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: #fff;
        height: 88px;
        overflow: hidden;
        padding: 4px;
      }
      .alertList {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    </style>
  </head>
  <body>
    <div class="title">${i18n.header}</div>

    <div class="section" id="snapshotSection">
      <div class="hd row space">
        <span>${i18n.goal}</span>
        <button id="btnSetGoal">${i18n.importGoal}</button>
      </div>
      <div class="bd">
        <div id="goalText" class="goalText oneLine">${i18n.goalPlaceholder}</div>
      </div>
    </div>

    <div class="section" id="monitorSection">
      <div class="hd row space">
        <span>${i18n.snapshot}</span>
        <button id="btnForceRefresh">${i18n.forceRefresh}</button>
      </div>
      <div class="bd grid4">
        <div class="result">
          <div class="k">${i18n.status}</div>
          <div class="v state-warn" id="summaryStatus">${i18n.statusNotStarted}</div>
          <div class="small" id="summaryStatusMeta">—</div>
        </div>
        <div class="result">
          <div class="k">${i18n.progress}</div>
          <div class="v" id="summaryProgress">—</div>
        </div>
        <div class="result">
          <div class="k">${i18n.deviation}</div>
          <div class="v state-warn" id="summaryDeviation">—</div>
        </div>
        <div class="result">
          <div class="k">${i18n.validity}</div>
          <div class="v" id="summaryValidity">—</div>
        </div>
        <div class="result" style="grid-column: 1 / -1;">
          <div class="k">${i18n.runtime}</div>
          <div class="runtimeGrid">
            <div class="runtimeItem">
              <div class="runtimeLabel">${i18n.runtimeEngaged}</div>
              <div class="runtimeVal" id="runtimeEngagedVal">${i18n.no}</div>
            </div>
            <div class="runtimeItem">
              <div class="runtimeLabel">${i18n.runtimeHandling}</div>
              <div class="runtimeVal" id="runtimeHandlingVal">${i18n.no}</div>
            </div>
            <div class="runtimeItem">
              <div class="runtimeLabel">${i18n.runtimeRealtime}</div>
              <div class="runtimeVal" id="runtimeRealtimeVal">${i18n.no}</div>
            </div>
          </div>
          <div class="small" id="runtimeDetail">—</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="hd row space">
        <span>${i18n.monitor}</span>
        <div id="monitorLevel" class="level-ok">${i18n.levelOk}</div>
      </div>
      <div class="bd">
        <div class="alertTicker">
          <div id="monitorTicker" class="alertList"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="hd">${i18n.signals}</div>
      <div class="bd kpi">
        <div class="pill signalCard" id="sigSource">
          <div><b>${i18n.signalSource}</b></div>
          <div class="signalV" id="sigSourceVal">—</div>
          <div class="signalHint">${i18n.signalClickHint}</div>
        </div>
        <div class="pill signalCard" id="sigErrors">
          <div><b>${i18n.signalErrors}</b></div>
          <div class="signalV" id="sigErrorsVal">0</div>
          <div class="signalHint">${i18n.signalClickHint}</div>
        </div>
        <div class="pill signalCard" id="sigBuild">
          <div><b>${i18n.signalBuild}</b></div>
          <div class="signalV" id="sigBuildVal">—</div>
          <div class="signalHint">${i18n.signalClickHint}</div>
        </div>
        <div class="pill signalCard" id="sigAlerts">
          <div><b>${i18n.signalAlerts}</b></div>
          <div class="signalV" id="sigAlertsVal">0</div>
          <div class="signalHint">${i18n.signalClickHint}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="hd">${i18n.plan}</div>
      <div class="bd">
        <div id="planList" class="list"></div>
        <div class="small">${i18n.planHelp}</div>
      </div>
    </div>

    <div class="section">
      <div class="hd">${i18n.chat}</div>
      <div class="bd">
        <div class="chat" id="chat"></div>
        <div class="chatBar">
          <input id="chatInput" placeholder="${i18n.chatPlaceholder}" />
          <button id="chatSend">${i18n.send}</button>
        </div>
      </div>
    </div>

    <script type="application/json" id="i18nPayload">${JSON.stringify(i18n)}</script>
    <script nonce="${n}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

