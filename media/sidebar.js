(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function parseI18n() {
    var raw = "{}";
    var payload = $("i18nPayload");
    if (payload && payload.textContent) {
      raw = payload.textContent;
    }
    try {
      return JSON.parse(raw);
    } catch (_err) {
      return {};
    }
  }

  function localizeAlert(s) {
    var t = String(s || "");
    var map = [
      ["No executable plan baseline.", "没有可执行的计划基线。"],
      ["Create or import 3-5 concrete plan steps.", "创建或导入 3-5 个具体计划步骤。"],
      ["Original goal baseline missing.", "缺少原始目标基线。"],
      ["Import conversation export to extract goal summary.", "导入会话导出以提取目标摘要。"],
      ["Latest build validity check failed.", "最近一次构建校验失败。"],
      ["Address build failure tail and rerun check.", "先修复构建失败信息，再重新校验。"],
      ["High chat activity but no recent code change (possible AI loop).", "对话很多但最近无代码变更（可能 AI 兜圈子）。"],
      ["Force concrete action: modify code, run build, or add measurable task.", "执行具体动作：改代码、跑构建或补可量化任务。"],
      ["Development signals look healthy.", "开发信号整体正常。"],
      ["Continue with next planned step and run validation.", "继续执行下一个计划步骤并进行验证。"],
      ["Fix first error in Problems panel and rerun validity check.", "先修复 Problems 面板的首个错误，再重跑校验。"]
    ];
    for (var i = 0; i < map.length; i += 1) {
      t = t.replace(map[i][0], map[i][1]);
    }
    return t;
  }

  try {
    var i18n = parseI18n();
    var vscode = acquireVsCodeApi();
    var fmtTime = function (ts) { return new Date(ts).toLocaleTimeString(); };
    var clamp01 = function (x) { return Math.max(0, Math.min(1, x)); };
    var pct = function (x) { return Math.round(clamp01(x) * 100) + "%"; };

    var chat = $("chat");
    var chatInput = $("chatInput");
    var chatSend = $("chatSend");
    var btnSetGoal = $("btnSetGoal");
    var btnForceRefresh = $("btnForceRefresh");
    var goalText = $("goalText");
    var planList = $("planList");

    if (!chat || !chatInput || !chatSend || !btnSetGoal || !goalText || !planList) {
      throw new Error("Critical UI element missing");
    }

    var tickerTimer = null;
    var tickerPaused = false;
    var goalExpanded = false;

    btnSetGoal.addEventListener("click", function () {
      btnSetGoal.textContent = i18n.importing || "Importing...";
      vscode.postMessage({ type: "command/setGoalFromClipboard" });
    });
    if (btnForceRefresh) {
      btnForceRefresh.addEventListener("click", function () {
        vscode.postMessage({ type: "command/forceRefreshAssessment" });
      });
    }

    goalText.addEventListener("click", function () {
      goalExpanded = !goalExpanded;
      if (goalExpanded) goalText.classList.remove("oneLine");
      else goalText.classList.add("oneLine");
    });


    var sendChat = function () {
      var text = String(chatInput.value || "").trim();
      if (!text) return;
      chatInput.value = "";
      vscode.postMessage({ type: "chat/send", payload: { text: text } });
    };
    chatSend.addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendChat();
    });

    var sigSource = $("sigSource");
    var sigErrors = $("sigErrors");
    var sigBuild = $("sigBuild");
    var sigAlerts = $("sigAlerts");
    if (sigSource) {
      sigSource.addEventListener("click", function () {
        var sec = $("snapshotSection");
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    if (sigErrors) {
      sigErrors.addEventListener("click", function () {
        vscode.postMessage({ type: "command/openProblems" });
      });
    }
    if (sigBuild) {
      sigBuild.addEventListener("click", function () {
        vscode.postMessage({ type: "command/openBuildDetail" });
      });
    }
    if (sigAlerts) {
      sigAlerts.addEventListener("click", function () {
        var sec = $("monitorSection");
        if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }

    function render(state) {
      var imported = Boolean(state.goal && state.goal.source && state.goal.source !== "none");
      if (imported) {
        btnSetGoal.textContent = i18n.importSuccess || "Imported";
        btnSetGoal.classList.add("btn-success");
        var title = state.goal && state.goal.title ? String(state.goal.title).trim() : "";
        var summary = state.goal && state.goal.summary ? String(state.goal.summary).trim() : "";
        var firstObjective = "";
        if (state.goal && Array.isArray(state.goal.objectives) && state.goal.objectives.length > 0) {
          firstObjective = String(state.goal.objectives[0]).trim();
        }
        var line = title && summary ? title + " - " + summary : (title || summary || firstObjective || i18n.goalPlaceholder || "-");
        goalText.textContent = line;
        if (!goalExpanded) goalText.classList.add("oneLine");
      } else {
        btnSetGoal.textContent = i18n.importGoal || "Import goal";
        btnSetGoal.classList.remove("btn-success");
        goalText.textContent = i18n.goalPlaceholder || "-";
        goalExpanded = false;
        goalText.classList.add("oneLine");
      }

      var v = state.validity || { state: "idle" };
      var validityLabel = v.state === "idle" ? (i18n.idle || "idle")
        : v.state === "running" ? (i18n.running || "running")
          : v.state === "passed" ? (i18n.passed || "passed")
            : (i18n.failed || "failed");

      var m = state.monitor || {};
      var a = state.assessment || {};
      var lv = $("monitorLevel");
      if (lv) {
        lv.className = "level-" + (m.level || "ok");
        lv.textContent = m.level === "critical" ? (i18n.levelCritical || "critical")
          : m.level === "warn" ? (i18n.levelWarn || "warn")
            : (i18n.levelOk || "ok");
      }

      var ticker = $("monitorTicker");
      if (ticker) {
        ticker.onmouseenter = function () { tickerPaused = true; };
        ticker.onmouseleave = function () { tickerPaused = false; };
        ticker.innerHTML = "";
        var tickerItems = []
          .concat(m.reasons || [])
          .concat(m.nextActions || [])
          .concat(a.alerts || [])
          .map(localizeAlert)
          .slice(0, 8);
        if (tickerItems.length === 0) {
          var empty = document.createElement("div");
          empty.className = "item";
          empty.textContent = "No alert.";
          ticker.appendChild(empty);
        } else {
          for (var i = 0; i < tickerItems.length; i += 1) {
            var item = document.createElement("div");
            item.className = "item";
            item.textContent = tickerItems[i];
            ticker.appendChild(item);
          }
        }
        if (tickerTimer) clearInterval(tickerTimer);
        if (ticker.children.length > 1) {
          tickerTimer = setInterval(function () {
            if (tickerPaused) return;
            ticker.appendChild(ticker.children[0]);
          }, 5200);
        }
      }

      var hasGoal = Boolean(state.goal && state.goal.source && state.goal.source !== "none");
      var hasPlan = Array.isArray(state.plan) && state.plan.length > 0;
      var done = hasPlan ? state.plan.filter(function (p) { return p.done; }).length : 0;
      var runtime = state.monitorRuntime || {};
      var runtimeState = String(runtime.state || (hasGoal ? "active" : "not_started"));
      var status = runtimeState === "blocked"
        ? (i18n.statusBlocked || "Blocked")
        : runtimeState === "lagging"
          ? (i18n.statusLagging || "Lagging feedback")
          : runtimeState === "active"
            ? (i18n.statusRunning || "Monitoring")
            : (i18n.statusNotStarted || "Not started");

      var summaryStatus = $("summaryStatus");
      if (summaryStatus) {
        summaryStatus.textContent = status;
        summaryStatus.className = "v " + (
          runtimeState === "active"
            ? "state-good"
            : runtimeState === "not_started"
              ? "state-bad"
              : "state-warn"
        );
        if (runtime && runtime.detail) summaryStatus.title = String(runtime.detail);
      }
      var summaryStatusMeta = $("summaryStatusMeta");
      if (summaryStatusMeta) {
        var lr = state.llmRefresh || { state: "idle" };
        var lrState = String(lr.state || "idle");
        var lrLabel =
          lrState === "loading" ? (i18n.llmLoading || "loading...")
            : lrState === "done" ? (i18n.llmDone || "done")
              : lrState === "error" ? (i18n.llmError || "error")
                : (i18n.llmIdle || "idle");
        var when = lr.updatedAt ? fmtTime(lr.updatedAt) : "—";
        summaryStatusMeta.textContent = (i18n.llmRefresh || "LLM refresh") + ": " + lrLabel + " @ " + when;
        if (lr.note) summaryStatusMeta.title = String(lr.note);
      }
      if (btnForceRefresh) {
        var isLoading = (state.llmRefresh || {}).state === "loading";
        btnForceRefresh.disabled = Boolean(isLoading);
        btnForceRefresh.textContent = isLoading
          ? (i18n.forceRefreshing || "Refreshing...")
          : (i18n.forceRefresh || "Force refresh");
      }
      var yesText = i18n.yes || "Yes";
      var noText = i18n.no || "No";
      var runtimeEngagedVal = $("runtimeEngagedVal");
      if (runtimeEngagedVal) runtimeEngagedVal.textContent = runtime.engaged ? yesText : noText;
      var runtimeHandlingVal = $("runtimeHandlingVal");
      if (runtimeHandlingVal) runtimeHandlingVal.textContent = runtime.handling ? yesText : noText;
      var runtimeRealtimeVal = $("runtimeRealtimeVal");
      if (runtimeRealtimeVal) runtimeRealtimeVal.textContent = runtime.realtime ? yesText : noText;
      var runtimeDetail = $("runtimeDetail");
      if (runtimeDetail) runtimeDetail.textContent = String(runtime.detail || "—");
      var summaryProgress = $("summaryProgress");
      if (summaryProgress) {
        var total = (state.plan || []).length;
        var progress01 = total > 0 ? (done / total) : 0;
        summaryProgress.textContent = pct(progress01);
        summaryProgress.title = String(a.progress || (done + "/" + total + " steps · " + ((state.diagnostics || {}).errors || 0) + " errors · build " + ((state.validity || {}).state || "idle")));
        summaryProgress.className = "v " + (progress01 >= 0.75 ? "state-good" : progress01 >= 0.45 ? "state-warn" : "state-bad");
      }
      var summaryDeviation = $("summaryDeviation");
      if (summaryDeviation) {
        summaryDeviation.textContent = pct((state.deviation || {}).score01 || 0);
        var score = (state.deviation || {}).score01 || 0;
        summaryDeviation.className = "v " + (score >= 0.75 ? "state-good" : score >= 0.45 ? "state-warn" : "state-bad");
      }
      var summaryValidity = $("summaryValidity");
      if (summaryValidity) {
        var validityMeaning = String(a.buildCheckMeaning || i18n.validityMeaningDefault || "");
        summaryValidity.textContent = validityLabel + " · " + validityMeaning;
        summaryValidity.title = validityMeaning;
      }

      planList.innerHTML = "";
      var plans = Array.isArray(state.plan) ? state.plan : [];
      if (plans.length === 0) {
        var emptyPlan = document.createElement("div");
        emptyPlan.className = "item";
        emptyPlan.textContent = i18n.noPlanYet || "No plan steps yet.";
        planList.appendChild(emptyPlan);
      } else {
        var groups = {};
        var groupOrder = [];
        for (var gpIdx = 0; gpIdx < plans.length; gpIdx += 1) {
          var gp = plans[gpIdx];
          var groupName = String(gp.group || i18n.groupDefault || "Ungrouped");
          if (!groups[groupName]) {
            groups[groupName] = [];
            groupOrder.push(groupName);
          }
          groups[groupName].push(gp);
        }

        for (var gIdx = 0; gIdx < groupOrder.length; gIdx += 1) {
          var gName = groupOrder[gIdx];
          var gPlans = groups[gName];
          var gDone = gPlans.filter(function (x) { return x.done; }).length;

          var details = document.createElement("details");
          details.className = "planGroup";
          if (gIdx <= 1) details.open = true;

          var summary = document.createElement("summary");
          summary.className = "planGroupSummary";
          summary.textContent = gName + " · " + gDone + "/" + gPlans.length;
          details.appendChild(summary);

          var groupBody = document.createElement("div");
          groupBody.className = "planGroupBody";

          for (var pIdx = 0; pIdx < gPlans.length; pIdx += 1) {
            var p = gPlans[pIdx];
            var row = document.createElement("div");
            row.className = "planEntry";

            var inner = document.createElement("div");
            inner.className = "planEntryRow";
            var icon = document.createElement("span");
            icon.className = p.done ? "planIconDone" : "planIconTodo";
            icon.textContent = p.done ? "✅" : "⬜";
            var text = document.createElement("span");
            text.textContent = String(p.text || "");
            if (p.done) text.className = "planTextDone";
            inner.appendChild(icon);
            inner.appendChild(text);
            row.appendChild(inner);
            groupBody.appendChild(row);
          }
          details.appendChild(groupBody);
          planList.appendChild(details);
        }
      }

      var src = a.source === "llm" ? "LLM" : "Heuristic";
      var sigSourceVal = $("sigSourceVal");
      if (sigSourceVal) sigSourceVal.textContent = src + " @ " + (a.updatedAt ? fmtTime(a.updatedAt) : "—");
      var sigErrorsVal = $("sigErrorsVal");
      if (sigErrorsVal) sigErrorsVal.textContent = String((state.diagnostics || {}).errors || 0);
      var sigBuildVal = $("sigBuildVal");
      if (sigBuildVal) sigBuildVal.textContent = validityLabel;
      var sigAlertsVal = $("sigAlertsVal");
      if (sigAlertsVal) sigAlertsVal.textContent = String((a.alerts || []).length || (m.reasons || []).length || 0);

      chat.innerHTML = "";
      var chatList = Array.isArray(state.chat) ? state.chat : [];
      for (var c = 0; c < chatList.length; c += 1) {
        var b = document.createElement("div");
        b.className = "bubble " + (chatList[c].role === "user" ? "user" : "assistant");
        b.textContent = chatList[c].text;
        chat.appendChild(b);
      }
      chat.scrollTop = chat.scrollHeight;
    }

    window.addEventListener("message", function (event) {
      var msg = event.data;
      if (!msg || msg.type !== "state") return;
      render(msg.payload || {});
    });

    vscode.postMessage({ type: "ui/ready" });
  } catch (err) {
    console.error("AI Dev Coach sidebar init failed:", err);
  }
})();
