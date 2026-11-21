export function benchHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TokenPilot</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.45;
    }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
    h2 { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
    p { margin: 0; color: var(--vscode-descriptionForeground); }
    .layout { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr); gap: 16px; margin-top: 16px; }
    @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } }
    .card {
      border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.35));
      border-radius: 8px;
      padding: 12px;
      background: var(--vscode-sideBar-background, transparent);
    }
    label { display: block; margin: 10px 0 4px; }
    textarea, input[type="text"], input[type="number"], select {
      width: 100%;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 6px 8px;
      font: inherit;
    }
    textarea { min-height: 180px; resize: vertical; }
    .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 10px; }
    .row label { margin: 0; display: flex; gap: 6px; align-items: center; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    button {
      font: inherit;
      border: 0;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: 0.45; cursor: default; }
    .meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 0 12px; }
    .meter { padding: 8px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(127,127,127,0.12)); }
    .meter strong { display: block; font-size: 18px; margin-top: 2px; }
    .meter.saved strong { color: var(--vscode-testing-iconPassed, #89d185); }
    ul { margin: 6px 0 0; padding-left: 18px; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 8px 0 0;
      padding: 8px;
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      max-height: 280px;
      overflow: auto;
    }
    .banner {
      margin-top: 12px;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--vscode-inputValidation-warningBackground, rgba(200, 150, 0, 0.15));
      border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
    }
    .error {
      background: var(--vscode-inputValidation-errorBackground, rgba(200, 0, 0, 0.15));
      border-color: var(--vscode-inputValidation-errorBorder, transparent);
    }
    .badge {
      display: inline-block;
      margin-left: 6px;
      padding: 0 6px;
      border-radius: 999px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .hidden { display: none; }
    .split { display: flex; gap: 8px; }
    .split input { flex: 1; }
  </style>
</head>
<body>
  <h1>TokenPilot</h1>
  <p id="stats">Ready.</p>
  <div id="banner" class="banner hidden"></div>
  <div class="layout">
    <section class="card">
      <h2>Task</h2>
      <label for="agent">Harness</label>
      <select id="agent">
        <option value="cursor">Cursor</option>
        <option value="claude-code">Claude Code</option>
        <option value="copilot">GitHub Copilot</option>
        <option value="tokenpilot">TokenPilot</option>
      </select>
      <label for="prompt">What should the agent do?</label>
      <textarea id="prompt" placeholder="Update checkout so guests can pay. Don't change charge()."></textarea>
      <div class="row">
        <label><input id="confidential" type="checkbox" /> Confidential repo</label>
        <label><input id="outage" type="checkbox" /> Provider is down</label>
        <label>Budget USD <input id="budget" type="number" min="0" step="0.01" value="2" style="width: 88px" /></label>
      </div>
      <div class="actions">
        <button id="optimize" type="button">Preview turn</button>
        <button id="sample" class="secondary" type="button">Load sample</button>
      </div>
      <p style="margin-top: 8px">Preview only counts tokens. A prompt you submit in Cursor is sent by the extension.</p>
      <div class="actions">
        <button id="reset" class="secondary" type="button">Reset spend</button>
      </div>
      <p id="ledger" style="margin-top: 8px"></p>
    </section>
    <section class="card">
      <h2>Turn</h2>
      <div class="meters">
        <div class="meter">Naive<strong id="naive">–</strong></div>
        <div class="meter">This turn<strong id="opt">–</strong></div>
        <div class="meter saved">Saved<strong id="saved">–</strong></div>
      </div>
      <div id="route"></div>
      <div id="actions"></div>
      <div id="tools"></div>
      <div id="promptOut"></div>
      <div id="reply"></div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const agentEl = document.getElementById("agent");
    const confidentialEl = document.getElementById("confidential");
    const outageEl = document.getElementById("outage");
    const budgetEl = document.getElementById("budget");
    const banner = document.getElementById("banner");
    let touched = false;

    function esc(value) {
      return String(value).replace(/[&<>]/g, function (ch) {
        return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;";
      });
    }
    function showBanner(text, isError) {
      banner.textContent = text;
      banner.className = isError ? "banner error" : "banner";
    }
    function hideBanner() {
      banner.className = "banner hidden";
    }
    function money(value) {
      return "$" + Number(value).toFixed(4);
    }

    document.getElementById("optimize").addEventListener("click", function () {
      hideBanner();
      vscode.postMessage({
        type: "optimize",
        prompt: promptEl.value,
        confidential: confidentialEl.checked,
        budgetUsd: Number(budgetEl.value),
        primaryUp: !outageEl.checked,
        agent: agentEl.value
      });
    });
    document.getElementById("sample").addEventListener("click", function () {
      vscode.postMessage({ type: "sample" });
    });
    document.getElementById("reset").addEventListener("click", function () {
      vscode.postMessage({ type: "resetSpend" });
    });
    promptEl.addEventListener("input", function () { touched = true; });
    confidentialEl.addEventListener("change", function () { touched = true; });
    budgetEl.addEventListener("input", function () { touched = true; });

    window.addEventListener("message", function (event) {
      const msg = event.data;
      if (msg.type === "state") renderState(msg);
      else if (msg.type === "report") renderReport(msg);
      else if (msg.type === "prefill") { promptEl.value = msg.prompt; }
      else if (msg.type === "sent") renderSent(msg);
      else if (msg.type === "error") showBanner(msg.message, true);
    });

    function renderState(msg) {
      document.getElementById("stats").textContent = "Local rewrite, history, tools, then Bifrost.";
      hideBanner();
      if (!touched) {
        budgetEl.value = String(msg.budgetUsd);
        confidentialEl.checked = msg.confidential;
      }
      const remaining = Math.max(0, Number(budgetEl.value) - msg.spentUsd);
      document.getElementById("ledger").textContent =
        "User " + msg.userId + " · spent " + money(msg.spentUsd) + " · remaining " + money(remaining) +
        " · local " + msg.models.local + " · small " + msg.models.small + " · strong " + msg.models.strong;
    }
    function renderReport(msg) {
      const tokens = msg.report.tokens;
      document.getElementById("naive").textContent = String(tokens.baseline);
      document.getElementById("opt").textContent = String(tokens.optimized);
      document.getElementById("saved").textContent = tokens.saved + " (" + tokens.savedPct + "%)";
      const route = msg.route;
      const model = route.model || "none";
      document.getElementById("route").innerHTML =
        "<h2>Route</h2><p>" + esc(route.reason) + "</p><p>" + esc(route.via) + " · " + esc(model) +
        " · about " + money(route.estimatedCostUsd) + "</p>" +
        (route.notifyUser ? "<div class='banner'>" + esc(route.notifyUser) + "</div>" : "") +
        (route.fallbacks.length ? "<p>Fallbacks: " + esc(route.fallbacks.join(", ")) + "</p>" : "");
      document.getElementById("actions").innerHTML = "<h2>What changed</h2><ul>" +
        msg.report.actions.map(function (item) { return "<li>" + esc(item) + "</li>"; }).join("") + "</ul>";
      document.getElementById("tools").innerHTML = "<h2>Tools on this turn" +
        (msg.report.agentLabel ? " · " + esc(msg.report.agentLabel) : "") + "</h2><ul>" +
        msg.report.tools.map(function (tool) {
          return "<li><code>" + esc(tool.name) + "</code>" +
            (tool.requiresApproval ? "<span class='badge'>approval</span>" : "") +
            " " + esc(tool.description) + "</li>";
        }).join("") + "</ul>";
      document.getElementById("promptOut").innerHTML =
        "<h2>Prompt the extension would send</h2><pre>" + esc(msg.report.systemPrompt) +
        "\\n\\nUSER\\n" + esc(msg.report.userText) + "</pre>";
      document.getElementById("reply").innerHTML = "";
      hideBanner();
      if (route.notifyUser) showBanner(route.notifyUser, route.blocked);
    }
    function renderSent(msg) {
      const note = msg.notice ? "<div class='banner'>" + esc(msg.notice) + "</div>" : "";
      document.getElementById("reply").innerHTML =
        "<h2>Reply · " + esc(msg.model) + "</h2>" + note + "<pre>" + esc(msg.content) + "</pre>" +
        "<p>Spent " + money(msg.spentUsd) + " · remaining " + money(msg.remainingUsd) + "</p>";
    }
  </script>
</body>
</html>`;
}
