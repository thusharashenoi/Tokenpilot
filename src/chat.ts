import crypto from "crypto";
import * as vscode from "vscode";
import { harnessFor, sampleTask, toOpenAITools } from "./core";

export type ChatMode = "bare" | "tokenpilot";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  meta?: string;
  pending?: boolean;
};

type Settings = { models: { strong: string } };

export class ChatSession {
  private mode: ChatMode = "tokenpilot";
  private messages: ChatMessage[] = [];
  private busy = false;
  private readonly listeners = new Set<(state: ReturnType<ChatSession["snapshot"]>) => void>();

  constructor(
    private readonly port: () => number,
    private readonly settings: () => Settings,
  ) {}

  subscribe(listener: (state: ReturnType<ChatSession["snapshot"]>) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setMode(mode: ChatMode): void {
    this.mode = mode;
    this.publish();
  }

  clear(): void {
    if (this.busy) {
      return;
    }
    this.messages = [];
    this.publish();
  }

  async send(text: string): Promise<void> {
    const task = text.trim();
    if (!task || this.busy) {
      return;
    }
    const mode = this.mode;
    this.busy = true;
    this.messages.push({ id: crypto.randomUUID(), role: "user", text: task });
    const pending: ChatMessage = { id: crypto.randomUUID(), role: "assistant", text: "Working…", pending: true };
    this.messages.push(pending);
    this.publish();
    try {
      const card = await this.post(task, mode);
      pending.pending = false;
      pending.text = card.error ? card.error : card.reply || "No reply.";
      pending.meta = card.error
        ? undefined
        : `${mode === "tokenpilot" ? "Custom harness" : "Cursor harness"} · ${card.model} · prompt ${card.promptBefore} → ${card.promptAfter} · completion ${card.completionTokens ?? "—"}${card.stages ? ` · ${card.stages}` : ""}`;
    } catch (error) {
      pending.pending = false;
      pending.text = error instanceof Error ? error.message : "The send failed.";
    }
    this.busy = false;
    this.publish();
  }

  private snapshot() {
    return { mode: this.mode, busy: this.busy, messages: this.messages };
  }

  private publish(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  private async post(task: string, mode: ChatMode): Promise<{
    model: string;
    promptBefore: number;
    promptAfter: number;
    completionTokens: number | null;
    stages: string | null;
    reply: string;
    error: string | null;
  }> {
    const bare = mode !== "tokenpilot";
    const harness = bare ? harnessFor("cursor") : null;
    const response = await fetch(`http://127.0.0.1:${this.port()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tokenpilot-optimize": bare ? "off" : "on",
        "x-tokenpilot-lock-model": "on",
      },
      body: JSON.stringify({
        model: this.settings().models.strong,
        stream: false,
        messages: harness
          ? [{ role: "system", content: harness.systemPrompt }, { role: "user", content: task }]
          : [{ role: "user", content: task }],
        tools: harness ? toOpenAITools(harness.tools) : undefined,
      }),
    });
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
      model?: string;
    };
    const header = (name: string): number | null => {
      const raw = response.headers.get(name);
      if (!raw) {
        return null;
      }
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    };
    return {
      model: payload.model || this.settings().models.strong,
      promptBefore: header("x-tokenpilot-prompt-before") ?? 0,
      promptAfter: header("x-tokenpilot-prompt-after") ?? 0,
      completionTokens: header("x-tokenpilot-completion"),
      stages: response.headers.get("x-tokenpilot-stages"),
      reply: payload.choices?.[0]?.message?.content ?? "",
      error: payload.error?.message ?? (response.ok ? null : `HTTP ${response.status}`),
    };
  }
}

export class ChatView implements vscode.WebviewViewProvider {
  constructor(private readonly session: ChatSession) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    this.mount(view.webview, (listener) => view.onDidDispose(listener));
  }

  private mount(webview: vscode.Webview, onDispose: (listener: () => void) => void): void {
    webview.html = chatHtml(webview.cspSource, crypto.randomBytes(16).toString("hex"));
    const unsubscribe = this.session.subscribe((state) => {
      void webview.postMessage({ type: "state", ...state });
    });
    onDispose(unsubscribe);
    webview.onDidReceiveMessage((message: { type?: string; text?: string; mode?: ChatMode }) => {
      if (message.type === "send") {
        void this.session.send(message.text ?? "");
      } else if (message.type === "mode" && (message.mode === "bare" || message.mode === "tokenpilot")) {
        this.session.setMode(message.mode);
      } else if (message.type === "clear") {
        this.session.clear();
      }
    });
  }
}

function chatHtml(cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.3)); }
    header strong { font-size: 13px; }
    button.link { background: none; color: var(--vscode-textLink-foreground); border: 0; padding: 0; cursor: pointer; font: inherit; }
    #log { flex: 1; overflow: auto; padding: 16px 14px 8px; }
    .empty { color: var(--vscode-descriptionForeground); margin-top: 12vh; text-align: center; }
    .empty h1 { font-size: 20px; font-weight: 600; color: var(--vscode-foreground); margin: 0 0 6px; }
    .msg { max-width: 720px; margin: 0 auto 14px; }
    .msg.user { display: flex; justify-content: flex-end; }
    .bubble { padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
    .user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-bottom-right-radius: 4px; max-width: 85%; }
    .assistant .bubble { background: transparent; padding-left: 0; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 4px; }
    .pending { color: var(--vscode-descriptionForeground); }
    form { margin: 0 auto; width: min(720px, calc(100% - 20px)); border: 1px solid var(--vscode-input-border, rgba(127,127,127,0.45)); border-radius: 12px; padding: 8px; margin-bottom: 12px; background: var(--vscode-input-background); }
    .route-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .route-row label { color: var(--vscode-descriptionForeground); flex: 0 0 auto; }
    select { flex: 1; min-width: 0; font: inherit; color: var(--vscode-dropdown-foreground, var(--vscode-foreground)); background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(127,127,127,0.45))); border-radius: 6px; padding: 4px 8px; }
    textarea { width: 100%; box-sizing: border-box; resize: none; overflow: auto; border: 0; outline: none; background: transparent; color: var(--vscode-input-foreground); font: inherit; line-height: 1.45; min-height: 72px; max-height: calc(100vh - 150px); }
    .bar { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .bar button { border: 0; border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .bar button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .bar button:disabled { opacity: 0.45; cursor: default; }
  </style>
</head>
<body>
  <header><strong>TokenPilot</strong><button id="clear" class="link" type="button">New chat</button></header>
  <div id="log"></div>
  <form id="composer">
    <div class="route-row">
      <label for="mode">Route</label>
      <select id="mode">
        <option value="bare">Bare Bifrost (Cursor harness)</option>
        <option value="tokenpilot">Custom harness</option>
      </select>
    </div>
    <textarea id="input" rows="2" placeholder="Ask about this repository"></textarea>
    <div class="bar">
      <button id="demo" class="secondary" type="button">Demo prompt</button>
      <button id="go" type="submit">Send</button>
    </div>
  </form>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const log = document.getElementById("log");
    const input = document.getElementById("input");
    const go = document.getElementById("go");
    const modeEl = document.getElementById("mode");
    const demoPrompt = ${JSON.stringify(sampleTask())};
    let mode = "tokenpilot";
    let busy = false;
    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>]/g, function (ch) {
        return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;";
      });
    }
    function paintMode() {
      modeEl.value = mode;
    }
    function fitInput() {
      input.style.height = "auto";
      const limit = Math.max(120, window.innerHeight - 150);
      input.style.height = Math.min(input.scrollHeight, limit) + "px";
    }
    function render(messages) {
      if (!messages.length) {
        log.innerHTML = "<div class='empty'><h1>TokenPilot</h1><p>Press Demo prompt, choose a route, then Send. Switch the route and send that same prompt again.</p></div>";
        return;
      }
      log.innerHTML = messages.map(function (message) {
        const meta = message.meta ? "<div class='meta'>" + esc(message.meta) + "</div>" : "";
        return "<div class='msg " + message.role + "'><div><div class='bubble" + (message.pending ? " pending" : "") + "'>" + esc(message.text) + "</div>" + meta + "</div></div>";
      }).join("");
      log.scrollTop = log.scrollHeight;
    }
    modeEl.addEventListener("change", function () {
      mode = modeEl.value;
      vscode.postMessage({ type: "mode", mode: mode });
    });
    document.getElementById("demo").addEventListener("click", function () {
      input.value = demoPrompt;
      fitInput();
      input.focus();
    });
    document.getElementById("composer").addEventListener("submit", function (event) {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || busy) return;
      input.value = "";
      fitInput();
      vscode.postMessage({ type: "send", text: text });
    });
    input.addEventListener("input", fitInput);
    window.addEventListener("resize", fitInput);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        document.getElementById("go").click();
      }
    });
    document.getElementById("clear").addEventListener("click", function () {
      vscode.postMessage({ type: "clear" });
    });
    window.addEventListener("message", function (event) {
      const msg = event.data;
      if (msg.type !== "state") return;
      mode = msg.mode;
      busy = msg.busy;
      go.disabled = busy;
      input.disabled = busy;
      paintMode();
      render(msg.messages || []);
    });
    paintMode();
    render([]);
  </script>
</body>
</html>`;
}
