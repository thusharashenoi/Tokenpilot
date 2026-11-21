import crypto from "crypto";
import * as vscode from "vscode";
import { harnessFor, sampleTask, toOpenAITools } from "./core";
import { listRuns } from "./proxy";

type Card = {
  model: string;
  promptBefore: number;
  promptAfter: number;
  completionTokens: number | null;
  storedTokens: number | null;
  reasoningTokens: number | null;
  notice: string | null;
  reply: string;
  error: string | null;
  latencyMs: number;
};

export class DashboardView implements vscode.WebviewViewProvider {
  constructor(
    private readonly port: () => number,
    private readonly sessionSettings: () => { bifrostUrl: string; models: { strong: string } },
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = dashboardHtml(view.webview.cspSource, crypto.randomBytes(16).toString("hex"));
    view.webview.onDidReceiveMessage((message: { type?: string; prompt?: string; mode?: string }) => {
      if (message.type === "sample") {
        void view.webview.postMessage({ type: "prefill", prompt: sampleTask() });
      } else if (message.type === "refresh") {
        void view.webview.postMessage({ type: "runs", runs: listRuns() });
      } else if (message.type === "send") {
        void this.send(view, message.prompt ?? "", message.mode === "tokenpilot" ? "tokenpilot" : "bare");
      } else if (message.type === "compare") {
        void this.compare(view, message.prompt ?? "");
      }
    });
    void view.webview.postMessage({ type: "runs", runs: listRuns(), port: this.port(), bifrost: this.sessionSettings().bifrostUrl });
  }

  private async compare(view: vscode.WebviewView, prompt: string): Promise<void> {
    const task = prompt.trim();
    if (!task) {
      void view.webview.postMessage({ type: "error", message: "Write a task first." });
      return;
    }
    const settings = this.sessionSettings();
    const harness = harnessFor("cursor");
    const body = {
      model: settings.models.strong,
      stream: false,
      messages: [
        { role: "system", content: harness.systemPrompt },
        { role: "user", content: task },
      ],
      tools: toOpenAITools(harness.tools),
    };
    try {
      const bare = await this.arm("off", body);
      const tokenpilot = await this.arm("on", body);
      void view.webview.postMessage({
        type: "result",
        bare,
        tokenpilot,
        runs: listRuns(),
        port: this.port(),
        bifrost: settings.bifrostUrl,
      });
    } catch (error) {
      void view.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "The comparison failed.",
      });
    }
  }

  private async send(view: vscode.WebviewView, prompt: string, mode: "bare" | "tokenpilot"): Promise<void> {
    const task = prompt.trim();
    if (!task) {
      void view.webview.postMessage({ type: "error", message: "Write a task first." });
      return;
    }
    const settings = this.sessionSettings();
    const harness = harnessFor("cursor");
    const body = {
      model: settings.models.strong,
      stream: false,
      messages: [
        { role: "system", content: harness.systemPrompt },
        { role: "user", content: task },
      ],
      tools: toOpenAITools(harness.tools),
    };
    try {
      const card = await this.arm(mode === "tokenpilot" ? "on" : "off", body);
      void view.webview.postMessage({
        type: "result",
        bare: mode === "bare" ? card : undefined,
        tokenpilot: mode === "tokenpilot" ? card : undefined,
        runs: listRuns(),
        port: this.port(),
        bifrost: settings.bifrostUrl,
      });
    } catch (error) {
      void view.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "The send failed.",
      });
    }
  }

  private async arm(optimize: "on" | "off", body: unknown): Promise<Card> {
    const response = await fetch(`http://127.0.0.1:${this.port()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenpilot-optimize": optimize,
        "x-tokenpilot-lock-model": "on",
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
      model?: string;
    };
    const reply = payload.choices?.[0]?.message?.content ?? "";
    const notice = response.headers.get("x-tokenpilot-notice") || null;
    const numberHeader = (name: string): number | null => {
      const raw = response.headers.get(name);
      if (!raw) {
        return null;
      }
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    return {
      model: payload.model || "none",
      promptBefore: numberHeader("x-tokenpilot-prompt-before") ?? 0,
      promptAfter: numberHeader("x-tokenpilot-prompt-after") ?? 0,
      completionTokens: numberHeader("x-tokenpilot-completion"),
      storedTokens: numberHeader("x-tokenpilot-stored"),
      reasoningTokens: numberHeader("x-tokenpilot-reasoning"),
      notice,
      reply,
      error: payload.error?.message ?? (response.ok ? null : `HTTP ${response.status}`),
      latencyMs: 0,
    };
  }
}

function dashboardHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
    h1 { font-size: 16px; margin: 0 0 4px; }
    h2 { font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
    p { margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
    textarea, button, select { font: inherit; }
    select { width: 100%; box-sizing: border-box; margin: 4px 0 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px; }
    textarea { width: 100%; min-height: 120px; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px 8px; }
    .row { display: flex; gap: 8px; margin: 8px 0 12px; flex-wrap: wrap; }
    button { border: 0; border-radius: 4px; padding: 6px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
    .card { border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.35)); border-radius: 8px; padding: 10px; }
    .meter { font-size: 18px; font-weight: 600; }
    pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12)); padding: 8px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); vertical-align: top; }
    .banner { margin: 8px 0; padding: 8px; border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.15)); }
    .error { background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.15)); }
  </style>
</head>
<body>
  <h1>TokenPilot dashboard</h1>
  <p id="meta">Proxy starting…</p>
  <label for="mode">Route</label>
  <select id="mode">
    <option value="bare">Bare Bifrost</option>
    <option value="tokenpilot">With TokenPilot</option>
  </select>
  <label for="prompt">Task</label>
  <textarea id="prompt" placeholder="Update checkout so guests can pay. Don't change charge()."></textarea>
  <div class="row">
    <button id="send" type="button">Send</button>
    <button id="both" class="secondary" type="button">Send both</button>
    <button id="sample" class="secondary" type="button">Load sample</button>
    <button id="refresh" class="secondary" type="button">Refresh runs</button>
  </div>
  <p>Each send is one Bifrost log. Bare Bifrost skips TokenPilot. With TokenPilot shrinks the prompt first. Send both, then refresh LLM Logs.</p>
  <div id="banner" class="banner" style="display:none"></div>
  <div class="grid">
    <section class="card" id="bare"><h2>Bare Bifrost</h2><p>Not run yet.</p></section>
    <section class="card" id="tokenpilot"><h2>With TokenPilot</h2><p>Not run yet.</p></section>
  </div>
  <h2 style="margin-top:16px">Recent proxy runs</h2>
  <table><thead><tr><th>Arm</th><th>Prompt</th><th>Wrote</th><th>Stored</th><th>Model</th></tr></thead><tbody id="runs"></tbody></table>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const promptEl = document.getElementById("prompt");
    const modeEl = document.getElementById("mode");
    const banner = document.getElementById("banner");
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>]/g, function (ch) {
        return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;";
      });
    }
    function showError(text) {
      banner.style.display = "block";
      banner.className = "banner error";
      banner.textContent = text;
    }
    function card(title, run) {
      if (!run) return "<h2>" + title + "</h2><p>Not run yet.</p>";
      const err = run.error ? "<div class='banner error'>" + esc(run.error) + "</div>" : "";
      const note = run.notice ? "<div class='banner'>" + esc(run.notice) + "</div>" : "";
      return "<h2>" + title + "</h2>" + err + note +
        "<p class='meter'>" + esc(run.promptBefore) + " → " + esc(run.promptAfter) + " prompt</p>" +
        "<p>Model wrote " + esc(run.completionTokens) + " · stored " + esc(run.storedTokens) + " · " + esc(run.model) + "</p>" +
        "<pre>" + esc(run.reply) + "</pre>";
    }
    function drawRuns(runs) {
      document.getElementById("runs").innerHTML = (runs || []).slice(0, 12).map(function (run) {
        return "<tr><td>" + esc(run.arm) + "</td><td>" + esc(run.promptBefore) + " → " + esc(run.promptAfter) + "</td><td>" +
          esc(run.completionTokens) + "</td><td>" + esc(run.storedTokens) + "</td><td>" + esc(run.model) + "</td></tr>";
      }).join("");
    }
    document.getElementById("send").addEventListener("click", function () {
      banner.style.display = "none";
      vscode.postMessage({ type: "send", mode: modeEl.value, prompt: promptEl.value });
    });
    document.getElementById("both").addEventListener("click", function () {
      banner.style.display = "none";
      vscode.postMessage({ type: "compare", prompt: promptEl.value });
    });
    document.getElementById("sample").addEventListener("click", function () {
      vscode.postMessage({ type: "sample" });
    });
    document.getElementById("refresh").addEventListener("click", function () {
      vscode.postMessage({ type: "refresh" });
    });
    window.addEventListener("message", function (event) {
      const msg = event.data;
      if (msg.type === "prefill") promptEl.value = msg.prompt;
      else if (msg.type === "error") showError(msg.message);
      else if (msg.type === "runs") {
        document.getElementById("meta").textContent = "Proxy http://127.0.0.1:" + (msg.port || "") + " · Bifrost " + (msg.bifrost || "");
        drawRuns(msg.runs);
      } else if (msg.type === "result") {
        document.getElementById("meta").textContent = "Proxy http://127.0.0.1:" + msg.port + " · Bifrost " + msg.bifrost;
        if (msg.bare) document.getElementById("bare").innerHTML = card("Bare Bifrost", msg.bare);
        if (msg.tokenpilot) document.getElementById("tokenpilot").innerHTML = card("With TokenPilot", msg.tokenpilot);
        drawRuns(msg.runs);
      }
    });
  </script>
</body>
</html>`;
}
