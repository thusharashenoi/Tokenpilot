import crypto from "crypto";
import * as vscode from "vscode";
import {
  GraphIndex,
  MAX_OUTPUT_TOKENS,
  estimateCost,
  formatTokenPopup,
  harnessFor,
  isAgentId,
  optimizeInput,
  routeTurn,
  sampleTask,
  sendViaBifrost,
  toOpenAITools,
  type AgentId,
  type ModelIds,
} from "./core";
import { benchHtml } from "./panel/html";
import type { HostToWebview, WebviewToHost } from "./protocol";

export class TokenPilotSession {
  readonly statusBar: vscode.StatusBarItem;
  private readonly index = new GraphIndex();
  private readonly listeners = new Set<(message: HostToWebview) => void>();
  private panel: vscode.WebviewPanel | undefined;
  private last: {
    report: ReturnType<typeof optimizeInput>;
    route: ReturnType<typeof routeTurn>;
    hit: ReturnType<GraphIndex["queryText"]>;
    limit: number;
  } | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBar.command = "tokenpilot.open";
    this.statusBar.text = "$(type-hierarchy) TokenPilot";
    this.statusBar.show();
  }

  subscribe(listener: (message: HostToWebview) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateMessage());
    if (this.last) {
      listener({ type: "report", report: this.last.report, route: this.last.route, hit: this.last.hit });
    }
    return () => this.listeners.delete(listener);
  }

  reindex(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.refreshStatus();
      this.post({ type: "error", message: "Open a folder to index a codebase." });
      return;
    }
    this.index.load(folder.uri.fsPath);
    this.refreshStatus();
    this.post(this.stateMessage());
  }

  onSave(document: vscode.TextDocument): void {
    if (document.uri.scheme !== "file") {
      return;
    }
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(document.fileName) || document.fileName.endsWith(".d.ts")) {
      return;
    }
    this.index.setFile(document.fileName, document.getText());
    this.refreshStatus();
    this.post(this.stateMessage());
  }

  openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel("tokenpilot.bench", "TokenPilot", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.webview.html = benchHtml(panel.webview.cspSource, crypto.randomBytes(16).toString("hex"));
    const unsubscribe = this.subscribe((message) => {
      void panel.webview.postMessage(message);
    });
    const incoming = panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.handle(message);
    });
    panel.onDidDispose(() => {
      incoming.dispose();
      unsubscribe();
      this.panel = undefined;
    });
  }

  async handle(message: WebviewToHost): Promise<void> {
    try {
      if (message.type === "reindex") {
        this.reindex();
      } else if (message.type === "sample") {
        this.post({ type: "prefill", prompt: sampleTask() });
      } else if (message.type === "resetSpend") {
        await this.context.workspaceState.update(this.spendKey(), 0);
        this.post(this.stateMessage());
      } else if (message.type === "lookup") {
        this.post({ type: "lookup", hit: this.index.querySymbol(message.name) });
      } else if (message.type === "optimize") {
        this.build(message.prompt, message.confidential, message.budgetUsd, message.primaryUp, message.agent);
      } else if (message.type === "send") {
        await this.send();
      }
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : "TokenPilot failed. The turn is still here." });
    }
  }

  private build(prompt: string, confidential: boolean, budgetUsd: number, primaryUp: boolean, agent?: AgentId): void {
    const task = prompt.trim();
    if (!task) {
      this.post({ type: "error", message: "Write a task first." });
      return;
    }
    const selected = agent && isAgentId(agent) ? agent : "cursor";
    const harness = harnessFor(selected);
    const limit = Number.isFinite(budgetUsd) && budgetUsd >= 0 ? budgetUsd : this.budgetLimit();
    const hit = this.index.queryText(task);
    const report = optimizeInput({
      systemPrompt: harness.systemPrompt,
      userText: task,
      tools: harness.tools,
      graphPack: hit.pack,
      fullFileTokens: hit.fullFileTokens,
      agentLabel: harness.label,
    });
    const route = routeTurn({
      confidential,
      taskKind: report.task,
      promptTokens: report.tokens.optimized,
      budgetRemainingUsd: limit - this.spent(),
      providerUp: primaryUp,
      models: this.models(),
    });
    this.last = { report, route, hit, limit };
    this.post({ type: "report", report, route, hit });
    this.showTokenPopup(report);
  }

  private async send(): Promise<void> {
    const model = this.last?.route.model;
    if (!this.last || !model || this.last.route.blocked || this.last.route.via === "none") {
      this.post({ type: "error", message: this.last?.route.notifyUser ?? "Build a turn before sending it." });
      return;
    }
    const config = vscode.workspace.getConfiguration("tokenpilot");
    const models = this.models();
    const decision = this.last.route;
    const result = await sendViaBifrost({
      via: decision.via === "local" ? "local" : "bifrost",
      baseUrl: config.get<string>("bifrostUrl") || "http://localhost:8080",
      path: config.get<string>("bifrostPath") || "/v1/chat/completions",
      model,
      fallbacks: decision.fallbacks,
      messages: this.last.report.messages,
      tools: toOpenAITools(this.last.report.tools),
      localBaseUrl: config.get<string>("localUrl") || "http://localhost:11434",
      localModel: models.local,
      maxTokens: MAX_OUTPUT_TOKENS,
    });
    const tier = result.modelUsed === models.local ? "local" : result.modelUsed === models.small ? "small" : "strong";
    const cost = result.usage
      ? estimateCost(tier, result.usage.promptTokens, result.usage.completionTokens)
      : decision.estimatedCostUsd;
    const spent = this.spent() + cost;
    await this.context.workspaceState.update(this.spendKey(), spent);
    this.post({
      type: "sent",
      content: result.content,
      model: result.modelUsed,
      notice: result.notifyUser ?? decision.notifyUser,
      spentUsd: spent,
      remainingUsd: Math.max(0, this.last.limit - spent),
    });
    this.post(this.stateMessage());
    this.showTokenPopup(
      this.last.report,
      result.usage ? { promptTokens: result.usage.promptTokens, model: result.modelUsed } : undefined,
    );
  }

  private showTokenPopup(
    report: ReturnType<typeof optimizeInput>,
    actual?: { promptTokens: number; model: string },
  ): void {
    const popup = formatTokenPopup(report, actual);
    void vscode.window.showInformationMessage(popup.message, { modal: true, detail: popup.detail });
  }

  private stateMessage(): HostToWebview {
    return {
      type: "state",
      stats: this.index.stats(),
      userId: this.userId(),
      budgetUsd: this.budgetLimit(),
      spentUsd: this.spent(),
      confidential: vscode.workspace.getConfiguration("tokenpilot").get<boolean>("confidential", false),
      models: this.models(),
    };
  }

  private models(): ModelIds {
    const config = vscode.workspace.getConfiguration("tokenpilot");
    return {
      local: config.get<string>("localModel") || "qwen2.5-coder:7b",
      small: config.get<string>("smallModel") || "openai/gpt-4o-mini",
      strong: config.get<string>("strongModel") || "openai/gpt-4o",
    };
  }

  private userId(): string {
    const configured = vscode.workspace.getConfiguration("tokenpilot").get<string>("userId")?.trim();
    return configured || process.env.USER || process.env.USERNAME || "local";
  }

  private budgetLimit(): number {
    return vscode.workspace.getConfiguration("tokenpilot").get<number>("budgetUsd", 2);
  }

  private spent(): number {
    return this.context.workspaceState.get<number>(this.spendKey(), 0);
  }

  private spendKey(): string {
    return `spend:${this.userId()}`;
  }

  publishState(): void {
    this.refreshStatus();
    this.post(this.stateMessage());
  }

  private refreshStatus(): void {
    if (!vscode.workspace.workspaceFolders?.[0]) {
      this.statusBar.text = "$(warning) TokenPilot";
      this.statusBar.tooltip = "Open a folder to index a codebase.";
      return;
    }
    const stats = this.index.stats();
    this.statusBar.text = stats.ok
      ? `$(type-hierarchy) TokenPilot ${stats.symbols}`
      : `$(warning) TokenPilot ${stats.symbols}`;
    this.statusBar.tooltip = stats.ok ? "Code graph is valid" : stats.issues.join("\n");
  }

  private post(message: HostToWebview): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}

export class BenchView implements vscode.WebviewViewProvider {
  constructor(private readonly session: TokenPilotSession) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = benchHtml(view.webview.cspSource, crypto.randomBytes(16).toString("hex"));
    const unsubscribe = this.session.subscribe((message) => {
      void view.webview.postMessage(message);
    });
    const incoming = view.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.session.handle(message);
    });
    view.onDidDispose(() => {
      incoming.dispose();
      unsubscribe();
    });
  }
}
