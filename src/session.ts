import crypto from "crypto";
import * as vscode from "vscode";
import {
  alignObjective,
  countTokens,
  estimateCost,
  fetchTavilyPack,
  formatTokenPopup,
  harnessFor,
  isAgentId,
  needsExternalFact,
  optimizeInput,
  rewriteReply,
  routeTurn,
  type RouteDecision,
  sampleTask,
  sendViaBifrost,
  tavilyQuery,
  toOpenAITools,
  type AgentId,
  type AlignedTurn,
  type ModelIds,
} from "./core";
import { applyCatalogChoice, listGatewayModels } from "./core/modelCatalog";
import { DEFAULT_REWRITE_MODEL, rewriteUserPrompt } from "./core/userPrompt";
import { benchHtml } from "./panel/html";
import type { HostToWebview, WebviewToHost } from "./protocol";

function geminiModel(fromEnv: string | undefined, fromSettings: string | undefined, fallback: string): string {
  const chosen = fromEnv?.trim() || fromSettings?.trim() || fallback;
  if (!chosen.startsWith("gemini/") || chosen === "gemini/gemini-2.5-flash-lite") {
    return fallback;
  }
  return chosen;
}

export class TokenPilotSession {
  readonly statusBar: vscode.StatusBarItem;
  private readonly listeners = new Set<(message: HostToWebview) => void>();
  private panel: vscode.WebviewPanel | undefined;
  private last: {
    report: ReturnType<typeof optimizeInput>;
    route: ReturnType<typeof routeTurn>;
    limit: number;
    output: AlignedTurn;
    urls: string[];
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
      listener({
        type: "report",
        report: this.last.report,
        route: this.last.route,
        output: this.preview(this.last.output),
      });
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
        await this.saveGateway(message);
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
    const prepared = await this.prepareOutput(report);
    const route = await this.withCatalog(
      routeTurn({
        confidential,
        taskKind: report.task,
        promptTokens: this.promptTokens(report, prepared.output),
        budgetRemainingUsd: limit - this.spent(),
        providerUp: primaryUp,
        models: this.models(),
      }),
      rewritten,
    );
    this.last = { report, route, limit, output: prepared.output, urls: prepared.urls };
    this.post({ type: "report", report, route, output: this.preview(prepared.output) });
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
    const prepared = await this.prepareOutput(report);
    this.last = { report, route, limit, output: prepared.output, urls: prepared.urls };
    this.post({ type: "report", report, route, output: this.preview(prepared.output) });
    const model = route.model;
    if (!model || route.blocked || route.via === "none") {
      const message = route.notifyUser ?? "TokenPilot did not send this turn.";
      this.post({ type: "error", message });
      return { content: message, model: "", notice: message };
    }
    const models = this.models();
    const aligned = prepared.output;
    const result = await sendViaBifrost({
      via: route.via === "local" ? "local" : "bifrost",
      baseUrl: config.get<string>("bifrostUrl") || "http://localhost:8080",
      path: config.get<string>("bifrostPath") || "/v1/chat/completions",
      model,
      fallbacks: route.fallbacks,
      messages: aligned.messages,
      tools: toOpenAITools(report.tools),
      localBaseUrl: config.get<string>("localUrl") || "http://localhost:11434",
      localModel: models.local,
      maxTokens: aligned.maxTokens,
      reasoningEffort: aligned.reasoning === "none" ? undefined : aligned.reasoning,
      signal,
    });
    const stored = rewriteReply(result.content, aligned.goal, prepared.urls.length > 0 ? prepared.urls : undefined);
    const tier = result.modelUsed === models.local ? "local" : result.modelUsed === models.small ? "small" : "strong";
    const cost = result.usage
      ? estimateCost(tier, result.usage.promptTokens, result.usage.completionTokens)
      : route.estimatedCostUsd;
    const spent = this.spent() + cost;
    await this.context.workspaceState.update(this.spendKey(), spent);
    const notice = result.notifyUser ?? route.notifyUser;
    const outputActions = stored.changed
      ? [`Reply ${stored.beforeTokens} → ${stored.afterTokens} tokens before it is stored.`]
      : ["Reply already matched the objective."];
    if (stored.droppedUrls.length > 0) {
      outputActions.push(`Dropped ${stored.droppedUrls.length} URL${stored.droppedUrls.length === 1 ? "" : "s"} that were not in the Tavily pack.`);
    }
    this.post({
      type: "sent",
      content: stored.text,
      model: result.modelUsed,
      notice,
      spentUsd: spent,
      remainingUsd: Math.max(0, limit - spent),
      completionTokens: result.usage?.completionTokens ?? null,
      rewrittenTokens: stored.afterTokens,
      reasoningTokens: result.usage?.reasoningTokens ?? null,
      outputActions,
    });
    this.post(this.stateMessage());
    const popup = formatTokenPopup(report, result.usage ? { promptTokens: result.usage.promptTokens, model: result.modelUsed } : undefined);
    void vscode.window.showInformationMessage(popup.message);
    return { content: stored.text, model: result.modelUsed, notice };
  }

  private async prepareOutput(report: ReturnType<typeof optimizeInput>): Promise<{ output: AlignedTurn; urls: string[] }> {
    const evidence = await this.externalEvidence(report.userText, "");
    const output = alignObjective(report.messages, {
      task: report.task,
      userText: report.userText,
      evidence: evidence.text,
    });
    output.actions = [...evidence.actions, ...output.actions];
    return { output, urls: evidence.urls };
  }

  private promptTokens(report: ReturnType<typeof optimizeInput>, output: AlignedTurn): number {
    return (
      report.tokens.optimized +
      countTokens(output.messages.find((message) => message.role === "system")?.content ?? "") -
      countTokens(report.systemPrompt)
    );
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

  private preview(output: AlignedTurn) {
    return {
      messages: output.messages,
      reasoning: output.reasoning,
      maxTokens: output.maxTokens,
      actions: output.actions,
      goal: output.goal,
    };
  }

  private async externalEvidence(userText: string, graphPack: string): Promise<{ text: string; urls: string[]; actions: string[] }> {
    if (!needsExternalFact(userText, graphPack)) {
      return { text: "", urls: [], actions: [] };
    }
    const key = await this.tavilyKey();
    if (!key) {
      return { text: "", urls: [], actions: ["Tavily key is not set. This turn will not search."] };
    }
    try {
      const pack = await fetchTavilyPack(tavilyQuery(userText), key);
      if (!pack.text) {
        return { text: "", urls: [], actions: ["Tavily returned no sources."] };
      }
      return { text: pack.text, urls: pack.urls, actions: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tavily search failed.";
      return { text: "", urls: [], actions: [`${message} Reasoning stays on the task.`] };
    }
  }

  private async tavilyKey(): Promise<string> {
    const fromEnv = process.env.TAVILY_API_KEY?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    return (await this.context.secrets.get("tokenpilot.tavilyApiKey"))?.trim() ?? "";
  }

  private async saveGateway(message: { localModel?: string; smallModel?: string; strongModel?: string; budgetUsd: number }): Promise<void> {
    const config = vscode.workspace.getConfiguration("tokenpilot");
    const target = vscode.ConfigurationTarget.Workspace;
    const local = message.localModel?.trim();
    const small = message.smallModel?.trim();
    const strong = message.strongModel?.trim();
    if (local) {
      await config.update("localModel", local, target);
    }
    if (small) {
      await config.update("smallModel", small, target);
    }
    if (strong) {
      await config.update("strongModel", strong, target);
    }
    if (Number.isFinite(message.budgetUsd) && message.budgetUsd >= 0) {
      await config.update("budgetUsd", message.budgetUsd, target);
    }
  }

  private models(): ModelIds {
    const config = vscode.workspace.getConfiguration("tokenpilot");
    return {
      local: process.env.LOCAL_MODEL?.trim() || config.get<string>("localModel") || "qwen2.5-coder:7b",
      small: geminiModel(process.env.BIFROST_SMALL_MODEL, config.get<string>("smallModel"), "gemini/gemini-3.5-flash-lite"),
      strong: geminiModel(process.env.BIFROST_STRONG_MODEL, config.get<string>("strongModel"), "gemini/gemini-3.5-flash-lite"),
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

  workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  gatewaySettings(): {
    bifrostUrl: string;
    bifrostPath: string;
    localUrl: string;
    models: ModelIds;
    confidential: boolean;
    budgetRemainingUsd: number;
    providerUp: boolean;
  } {
    const config = vscode.workspace.getConfiguration("tokenpilot");
    return {
      bifrostUrl: process.env.BIFROST_URL?.trim() || config.get<string>("bifrostUrl") || "http://localhost:8080",
      bifrostPath: process.env.BIFROST_PATH?.trim() || config.get<string>("bifrostPath") || "/v1/chat/completions",
      localUrl: process.env.LOCAL_URL?.trim() || config.get<string>("localUrl") || "http://localhost:11434",
      models: this.models(),
      confidential: config.get<boolean>("confidential", false),
      budgetRemainingUsd: Math.max(0, this.budgetLimit() - this.spent()),
      providerUp: true,
    };
  }

  async noteSpend(usd: number): Promise<void> {
    if (!Number.isFinite(usd) || usd <= 0) {
      return;
    }
    await this.context.workspaceState.update(this.spendKey(), this.spent() + usd);
    this.post(this.stateMessage());
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
