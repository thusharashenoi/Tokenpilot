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
    .models { display: grid; grid-template-columns: 1fr; gap: 0; margin-top: 8px; }
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
  <p id="stats">Indexing the workspace…</p>
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
      <div class="models">
        <label for="localModel">Local model</label>
        <input id="localModel" type="text" spellcheck="false" />
        <label for="smallModel">Small model</label>
        <input id="smallModel" type="text" spellcheck="false" />
        <label for="strongModel">Strong model</label>
        <input id="strongModel" type="text" spellcheck="false" />
      </div>
      <div class="actions">
        <button id="optimize" type="button">Build turn</button>
        <button id="sample" class="secondary" type="button">Load sample</button>
        <button id="reindex" class="secondary" type="button">Rebuild graph</button>
        <button id="send" type="button" disabled>Send optimized turn</button>
      </div>
      <p style="margin-top: 8px">Build the turn again after you change the task, the models, the budget, or either switch. Send uses the last built turn. Lookup uses the small model. Edits use the strong model, and the other one is the fallback.</p>
      <label for="symbol">Look up one symbol</label>
      <div class="split">
        <input id="symbol" type="text" placeholder="charge" />
        <button id="lookup" class="secondary" type="button">Look up</button>
      </div>
      <pre id="lookupOut" class="hidden"></pre>
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
    const localEl = document.getElementById("localModel");
    const smallEl = document.getElementById("smallModel");
    const strongEl = document.getElementById("strongModel");
    const sendEl = document.getElementById("send");
    const banner = document.getElementById("banner");
    const lookupOut = document.getElementById("lookupOut");
    let touched = false;
    let modelsTouched = false;
    let dirty = true;
    let lastBlocked = true;

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
    function syncSend() {
      sendEl.disabled = dirty || lastBlocked;
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
        agent: agentEl.value,
        localModel: localEl.value,
        smallModel: smallEl.value,
        strongModel: strongEl.value
      });
    });
    document.getElementById("sample").addEventListener("click", function () {
      vscode.postMessage({ type: "sample" });
    });
    document.getElementById("reindex").addEventListener("click", function () {
      vscode.postMessage({ type: "reindex" });
    });
    document.getElementById("send").addEventListener("click", function () {
      sendEl.disabled = true;
      vscode.postMessage({ type: "send" });
    });
    document.getElementById("lookup").addEventListener("click", function () {
      vscode.postMessage({ type: "lookup", name: document.getElementById("symbol").value });
    });
    document.getElementById("reset").addEventListener("click", function () {
      vscode.postMessage({ type: "resetSpend" });
    });
    promptEl.addEventListener("input", function () { touched = true; dirty = true; syncSend(); });
    agentEl.addEventListener("change", function () { dirty = true; syncSend(); });
    confidentialEl.addEventListener("change", function () { touched = true; dirty = true; syncSend(); });
    outageEl.addEventListener("change", function () { dirty = true; syncSend(); });
    budgetEl.addEventListener("input", function () { touched = true; dirty = true; syncSend(); });
    localEl.addEventListener("input", function () { modelsTouched = true; dirty = true; syncSend(); });
    smallEl.addEventListener("input", function () { modelsTouched = true; dirty = true; syncSend(); });
    strongEl.addEventListener("input", function () { modelsTouched = true; dirty = true; syncSend(); });

    window.addEventListener("message", function (event) {
      const msg = event.data;
      if (msg.type === "state") renderState(msg);
      else if (msg.type === "report") renderReport(msg);
      else if (msg.type === "lookup") renderLookup(msg.hit);
      else if (msg.type === "prefill") { promptEl.value = msg.prompt; dirty = true; syncSend(); }
      else if (msg.type === "sent") renderSent(msg);
      else if (msg.type === "error") {
        showBanner(msg.message, true);
        syncSend();
      }
    });

    function renderState(msg) {
      const issue = msg.stats.ok ? "graph valid" : msg.stats.issues.length + " graph issues";
      const when = msg.stats.builtAt ? " · indexed " + new Date(msg.stats.builtAt).toLocaleTimeString() : "";
      document.getElementById("stats").textContent =
        msg.stats.symbols + " symbols · " + msg.stats.edges + " edges · " + msg.stats.files + " files · " + issue + when;
      if (!msg.stats.ok && msg.stats.issues.length) showBanner(msg.stats.issues.join(" "), true);
      else hideBanner();
      if (!touched) {
        budgetEl.value = String(msg.budgetUsd);
        confidentialEl.checked = msg.confidential;
      }
      if (!modelsTouched) {
        localEl.value = msg.models.local;
        smallEl.value = msg.models.small;
        strongEl.value = msg.models.strong;
      }
      const remaining = Math.max(0, Number(budgetEl.value) - msg.spentUsd);
      document.getElementById("ledger").textContent =
        "User " + msg.userId + " · spent " + money(msg.spentUsd) + " · remaining " + money(remaining) +
        " · local " + msg.models.local + " · small " + msg.models.small + " · strong " + msg.models.strong;
    }
    function renderReport(msg) {
      dirty = false;
      lastBlocked = msg.route.blocked;
      syncSend();
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
        (route.fallbacks.length ? "<p>Fallbacks: " + esc(route.fallbacks.join(", ")) + "</p>" : "") +
        (msg.output ? "<p>Reasoning " + esc(msg.output.reasoning) + " · output cap " + esc(msg.output.maxTokens) + "</p>" : "");
      const outputActions = msg.output && msg.output.actions ? msg.output.actions : [];
      document.getElementById("actions").innerHTML = "<h2>What changed</h2><ul>" +
        msg.report.actions.concat(outputActions).map(function (item) { return "<li>" + esc(item) + "</li>"; }).join("") + "</ul>";
      document.getElementById("tools").innerHTML = "<h2>Tools on this turn" +
        (msg.report.agentLabel ? " · " + esc(msg.report.agentLabel) : "") + "</h2><ul>" +
        msg.report.tools.map(function (tool) {
          return "<li><code>" + esc(tool.name) + "</code>" +
            (tool.requiresApproval ? "<span class='badge'>approval</span>" : "") +
            " " + esc(tool.description) + "</li>";
        }).join("") + "</ul>";
      const hit = msg.hit;
      const symbolLine = hit.symbols.length
        ? hit.symbols.map(function (symbol) { return symbol.name + " " + symbol.file + ":" + symbol.startLine; }).join(", ")
        : "no symbol matched";
      const sentSystem = msg.output
        ? msg.output.messages.filter(function (message) { return message.role === "system"; }).map(function (message) { return message.content; }).join("\\n\\n")
        : msg.report.systemPrompt;
      const sentUser = msg.output
        ? msg.output.messages.filter(function (message) { return message.role === "user"; }).map(function (message) { return message.content; }).join("\\n\\n")
        : msg.report.userText;
      document.getElementById("promptOut").innerHTML =
        "<h2>Prompt that would be sent</h2><p>" + esc(symbolLine) + "</p><pre>" + esc(sentSystem) +
        "\\n\\nUSER\\n" + esc(sentUser) + "</pre>";
      document.getElementById("reply").innerHTML = "";
      hideBanner();
      if (route.notifyUser) showBanner(route.notifyUser, route.blocked);
    }
    function renderLookup(hit) {
      lookupOut.className = "";
      lookupOut.textContent = hit.pack
        ? hit.pack + "\\n\\npack " + hit.packTokens + " tokens · full files " + hit.fullFileTokens + " tokens"
        : "No symbol with that name is in the graph.";
    }
    function renderSent(msg) {
      syncSend();
      const note = msg.notice ? "<div class='banner'>" + esc(msg.notice) + "</div>" : "";
      const usage = [];
      if (msg.completionTokens != null) usage.push("model wrote " + msg.completionTokens);
      if (msg.rewrittenTokens != null) usage.push("stored " + msg.rewrittenTokens);
      if (msg.reasoningTokens != null) usage.push("reasoning " + msg.reasoningTokens);
      const extra = msg.outputActions && msg.outputActions.length
        ? "<ul>" + msg.outputActions.map(function (item) { return "<li>" + esc(item) + "</li>"; }).join("") + "</ul>"
        : "";
      document.getElementById("reply").innerHTML =
        "<h2>Reply · " + esc(msg.model) + "</h2>" + note + extra + "<pre>" + esc(msg.content) + "</pre>" +
        "<p>" + esc(usage.join(" · ")) + (usage.length ? " · " : "") + "spent " + money(msg.spentUsd) + " · remaining " + money(msg.remainingUsd) + "</p>";
    }
  </script>
</body>
</html>`;
}
