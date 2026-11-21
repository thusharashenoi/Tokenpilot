import crypto from "crypto";
import * as vscode from "vscode";
import {
  MAX_OUTPUT_TOKENS,
  estimateCost,
  formatTokenPopup,
  harnessFor,
  isAgentId,
  optimizeInput,
  routeTurn,
  type RouteDecision,
  sampleTask,
  sendViaBifrost,
  toOpenAITools,
  type AgentId,
  type ModelIds,
} from "./core";
import { applyCatalogChoice, listGatewayModels } from "./core/modelCatalog";
import { DEFAULT_REWRITE_MODEL, rewriteUserPrompt } from "./core/userPrompt";
import { benchHtml } from "./panel/html";
import type { HostToWebview, WebviewToHost } from "./protocol";

export class TokenPilotSession {
  readonly statusBar: vscode.StatusBarItem;
  private readonly listeners = new Set<(message: HostToWebview) => void>();
  private panel: vscode.WebviewPanel | undefined;
  private last: {
    report: ReturnType<typeof optimizeInput>;
    route: ReturnType<typeof routeTurn>;
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
      listener({ type: "report", report: this.last.report, route: this.last.route });
    }
    return () => this.listeners.delete(listener);
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
      if (message.type === "sample") {
        this.post({ type: "prefill", prompt: sampleTask() });
      } else if (message.type === "resetSpend") {
        await this.context.workspaceState.update(this.spendKey(), 0);
        this.post(this.stateMessage());
      } else if (message.type === "optimize") {
        await this.build(message.prompt, message.confidential, message.budgetUsd, message.primaryUp, message.agent);
      }
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : "TokenPilot failed. The turn is still here." });
    }
  }

  private async build(prompt: string, confidential: boolean, budgetUsd: number, primaryUp: boolean, agent?: AgentId): Promise<void> {
    const task = prompt.trim();
    if (!task) {
      this.post({ type: "error", message: "Write a task first." });
      return;
    }
    const selected = agent && isAgentId(agent) ? agent : "cursor";
    const harness = harnessFor(selected);
    const limit = Number.isFinite(budgetUsd) && budgetUsd >= 0 ? budgetUsd : this.budgetLimit();
    const rewritten = await this.rewriteTask(task);
    const report = optimizeInput({
      systemPrompt: harness.systemPrompt,
      userText: task,
      rewrittenUserText: rewritten,
      tools: harness.tools,
      agentLabel: harness.label,
    });
    const route = await this.withCatalog(
      routeTurn({
        confidential,
        taskKind: report.task,
        promptTokens: report.tokens.optimized,
        budgetRemainingUsd: limit - this.spent(),
        providerUp: primaryUp,
        models: this.models(),
      }),
      rewritten,
    );
    this.last = { report, route, limit };
    this.post({ type: "report", report, route });
    this.showTokenPopup(report);
  }

  async handleIdePrompt(prompt: string, signal?: AbortSignal): Promise<{ content: string; model: string; notice: string | null }> {
    const task = prompt.trim();
    if (!task) {
      throw new Error("Write a task first.");
    }
    if (signal?.aborted) {
      throw new Error("The IDE prompt was cancelled.");
    }
    const config = vscode.workspace.getConfiguration("tokenpilot");
    const harness = harnessFor("cursor");
    const limit = this.budgetLimit();
    const rewritten = await this.rewriteTask(task, signal);
    if (signal?.aborted) {
      throw new Error("The IDE prompt was cancelled.");
    }
    const report = optimizeInput({
      systemPrompt: harness.systemPrompt,
      userText: task,
      rewrittenUserText: rewritten,
      tools: harness.tools,
      agentLabel: harness.label,
    });
    const route = await this.withCatalog(
      routeTurn({
        confidential: config.get<boolean>("confidential", false),
        taskKind: report.task,
        promptTokens: report.tokens.optimized,
        budgetRemainingUsd: limit - this.spent(),
        providerUp: true,
        models: this.models(),
      }),
      rewritten,
    );
    this.last = { report, route, limit };
    this.post({ type: "report", report, route });
    const model = route.model;
    if (!model || route.blocked || route.via === "none") {
      const message = route.notifyUser ?? "TokenPilot did not send this turn.";
      this.post({ type: "error", message });
      return { content: message, model: "", notice: message };
    }
    const models = this.models();
    const result = await sendViaBifrost({
      via: route.via === "local" ? "local" : "bifrost",
      baseUrl: config.get<string>("bifrostUrl") || "http://localhost:8080",
      path: config.get<string>("bifrostPath") || "/v1/chat/completions",
      model,
      fallbacks: route.fallbacks,
      messages: report.messages,
      tools: toOpenAITools(report.tools),
      localBaseUrl: config.get<string>("localUrl") || "http://localhost:11434",
      localModel: models.local,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal,
    });
    const tier = result.modelUsed === models.local ? "local" : result.modelUsed === models.small ? "small" : "strong";
    const cost = result.usage
      ? estimateCost(tier, result.usage.promptTokens, result.usage.completionTokens)
      : route.estimatedCostUsd;
    const spent = this.spent() + cost;
    await this.context.workspaceState.update(this.spendKey(), spent);
    const notice = result.notifyUser ?? route.notifyUser;
    this.post({
      type: "sent",
      content: result.content,
      model: result.modelUsed,
      notice,
      spentUsd: spent,
      remainingUsd: Math.max(0, limit - spent),
    });
    this.post(this.stateMessage());
    const popup = formatTokenPopup(report, result.usage ? { promptTokens: result.usage.promptTokens, model: result.modelUsed } : undefined);
    void vscode.window.showInformationMessage(popup.message);
    return { content: result.content, model: result.modelUsed, notice };
  }

  private async withCatalog(decision: RouteDecision, text: string): Promise<RouteDecision> {
    const origin = vscode.workspace.getConfiguration("tokenpilot").get<string>("bifrostUrl") || "http://localhost:8080";
    const available = await listGatewayModels(origin);
    return applyCatalogChoice(decision, text, available);
  }

  private rewriteTask(text: string, signal?: AbortSignal): Promise<string> {
    const config = vscode.workspace.getConfiguration("tokenpilot");
    return rewriteUserPrompt(text, {
      url: config.get<string>("localUrl") || "http://127.0.0.1:11434",
      model: config.get<string>("rewriteModel") || DEFAULT_REWRITE_MODEL,
      signal,
    });
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
    this.statusBar.text = "$(plug) TokenPilot";
    this.statusBar.tooltip = "TokenPilot";
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
