import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { ChatSession, ChatView } from "./chat";
import { DashboardView } from "./dashboard";
import { formatTokenNotice, type TurnNotice } from "./core/cursorTurn";
import { clearEndpoint, defaultEndpointFile } from "./core/ideClient";
import type { ProxySpend } from "./core/proxy";
import { listGatewayModels, pickCatalogModel } from "./core/modelCatalog";
import { DEFAULT_REWRITE_MODEL, rewriteUserPrompt } from "./core/userPrompt";
import { loadEnvFile } from "./env";
import { customTaskFrom, runCustomHarness } from "./core/customHarness";
import { completeThroughProxy } from "./proxy";
import { startProxy, type RunningProxy } from "./proxyServer";
import { BenchView, TokenPilotSession } from "./session";

const latest = path.join(os.homedir(), ".cursor", "tokenpilot", "latest.json");

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  loadEnvFile(path.join(context.extensionPath, ".env"));
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    loadEnvFile(path.join(folder.uri.fsPath, ".env"));
  }
  const session = new TokenPilotSession(context);
  const proxyPort = vscode.workspace.getConfiguration("tokenpilot").get<number>("proxyPort", 8787);
  const chat = new ChatView(new ChatSession(() => proxyPort, () => session.gatewaySettings()));
  const output = vscode.window.createOutputChannel("TokenPilot");
  const tokenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  tokenStatus.command = "tokenpilot.chatView.focus";
  tokenStatus.text = "$(plug) TokenPilot";
  tokenStatus.tooltip = "TokenPilot proxy";
  tokenStatus.show();

  const ideToken = crypto.randomBytes(16).toString("hex");
  const endpointFile = defaultEndpointFile();
  let seen = readNotice(latest)?.id ?? "";
  let running: RunningProxy | undefined;
  let proxyUrl = "";
  let generation = 0;

  const forgetEndpoint = (): void => {
    clearEndpoint(endpointFile, ideToken);
  };

  const publish = (notice: TurnNotice): void => {
    seen = notice.id;
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    const tmp = `${latest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notice));
    fs.renameSync(tmp, latest);
    const text = formatTokenNotice(notice);
    const spent = notice.actualPromptTokens;
    tokenStatus.text =
      typeof spent === "number"
        ? `$(symbol-number) Spent ${spent.toLocaleString("en-US")} in`
        : `$(symbol-number) Sent ${notice.reducedTokens?.toLocaleString("en-US") ?? notice.promptTokens.toLocaleString("en-US")}`;
    tokenStatus.tooltip = proxyUrl ? `${text}\n\nProxy: ${proxyUrl}` : text;
    output.appendLine(text);
    void vscode.window.showInformationMessage(text);
  };

  const showFile = (): void => {
    const notice = readNotice(latest);
    if (!notice || notice.id === seen || !Number.isFinite(notice.promptTokens)) {
      return;
    }
    publish(notice);
  };

  const start = async (): Promise<void> => {
    const ticket = ++generation;
    await running?.close();
    if (ticket !== generation) {
      return;
    }
    running = undefined;
    proxyUrl = "";
    forgetEndpoint();
    const config = vscode.workspace.getConfiguration("tokenpilot");
    if (!config.get<boolean>("proxyEnabled", true)) {
      tokenStatus.text = "$(debug-disconnect) TokenPilot proxy off";
      tokenStatus.tooltip = "Enable tokenpilot.proxyEnabled so IDE prompts are sent by the extension.";
      return;
    }
    const port = config.get<number>("proxyPort", 8787);
    const upstream = config.get<string>("bifrostUrl") || "http://localhost:8080";
    const key = config.get<string>("bifrostKey")?.trim() ?? "";
    const rewriteUrl = config.get<string>("localUrl") || "http://127.0.0.1:11434";
    const rewriteModel = config.get<string>("rewriteModel") || DEFAULT_REWRITE_MODEL;
    try {
      const started = await startProxy({
        port,
        upstream,
        key,
        rewriteUser: (text) => rewriteUserPrompt(text, { url: rewriteUrl, model: rewriteModel }),
        pickModel: async (text) => {
          const available = await listGatewayModels(upstream);
          if (!available) {
            return null;
          }
          const picked = pickCatalogModel(text, available);
          return picked ? { model: picked.model, fallbacks: picked.fallbacks } : null;
        },
        onSpend: (spend) => publish(noticeFrom(spend)),
        ideToken,
        onIdeTurn: (input, signal) => session.handleIdePrompt(input.prompt, signal),
        onChatTurn: async (body, optimize, lockModel) => {
          const settings = session.gatewaySettings();
          if (optimize) {
            const config = vscode.workspace.getConfiguration("tokenpilot");
            const result = await runCustomHarness({
              task: customTaskFrom(body),
              localUrl: settings.localUrl,
              rewriteModel: config.get<string>("rewriteModel") || DEFAULT_REWRITE_MODEL,
              bifrostUrl: settings.bifrostUrl,
              bifrostPath: settings.bifrostPath,
              model: settings.models.strong,
              workspaceRoot: session.workspaceRoot(),
            });
            return { status: result.status, headers: result.headers, body: result.body };
          }
          const result = await completeThroughProxy({
            settings,
            workspaceRoot: session.workspaceRoot(),
            tavilyKey: process.env.TAVILY_API_KEY?.trim() || (await context.secrets.get("tokenpilot.tavilyApiKey"))?.trim() || "",
            body,
            optimize,
            lockModel,
          });
          return { status: result.status, headers: result.headers, body: result.body };
        },
      });
      if (ticket !== generation) {
        await started.close();
        return;
      }
      running = started;
      proxyUrl = `http://127.0.0.1:${running.port}/v1`;
      tokenStatus.text = `$(plug) TokenPilot :${running.port}`;
      tokenStatus.tooltip = `TokenPilot chat uses ${proxyUrl}. Cursor chat is not hooked.`;
      output.appendLine(`Extension listening on ${proxyUrl}. The VS Code chat uses this proxy. Cursor chat is left alone.`);
    } catch (error) {
      if (ticket !== generation) {
        return;
      }
      if (isAddrInUse(error) && (await portAccepts(port))) {
        proxyUrl = `http://127.0.0.1:${port}/v1`;
        tokenStatus.text = `$(plug) TokenPilot :${port}`;
        tokenStatus.tooltip = `Cursor OpenAI base URL: ${proxyUrl}`;
        output.appendLine(`Proxy already listening on ${proxyUrl}.`);
        return;
      }
      const message = error instanceof Error ? error.message : "TokenPilot could not start its proxy.";
      tokenStatus.text = "$(warning) TokenPilot proxy";
      tokenStatus.tooltip = message;
      output.appendLine(message);
    }
  };

  context.subscriptions.push(
    session.statusBar,
    tokenStatus,
    output,
    vscode.commands.registerCommand("tokenpilot.open", () => {
      void vscode.commands.executeCommand("tokenpilot.chatView.focus");
    }),
    vscode.commands.registerCommand("tokenpilot.setTavilyKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "Tavily API key",
        prompt: "Used when a task needs a fact the repository does not contain.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!value?.trim()) {
        return;
      }
      await context.secrets.store("tokenpilot.tavilyApiKey", value.trim());
      void vscode.window.showInformationMessage("Tavily key saved for this workspace.");
    }),
    vscode.commands.registerCommand("tokenpilot.proxyUrl", async () => {
      if (!proxyUrl) {
        const tip = tokenStatus.tooltip;
        void vscode.window.showWarningMessage(typeof tip === "string" ? tip : "The TokenPilot proxy is not listening.");
        return;
      }
      const models = vscode.workspace.getConfiguration("tokenpilot");
      const small = models.get<string>("smallModel") || "gemini/gemini-3.5-flash-lite";
      const strong = models.get<string>("strongModel") || "gemini/gemini-3.5-flash-lite";
      await vscode.env.clipboard.writeText(proxyUrl);
      void vscode.window.showInformationMessage(
        `Copied ${proxyUrl}. In Cursor Settings → Models, set the OpenAI base URL to that address and add ${small} and ${strong}.`,
      );
    }),
    vscode.window.registerWebviewViewProvider("tokenpilot.chatView", chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider("tokenpilot.benchView", new BenchView(session)),
    vscode.window.registerWebviewViewProvider(
      "tokenpilot.dashboardView",
      new DashboardView(
        () => proxyPort,
        () => session.gatewaySettings(),
      ),
    ),
    vscode.commands.registerCommand("tokenpilot.dashboard", () => {
      void vscode.commands.executeCommand("tokenpilot.dashboardView.focus");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenpilot")) {
        session.publishState();
        void start();
      }
    }),
    {
      dispose: () => {
        forgetEndpoint();
        void running?.close();
      },
    },
  );
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.watchFile(latest, { interval: 400 }, showFile);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(latest, showFile) });
  void start();
}

function isAddrInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EADDRINUSE");
}

async function portAccepts(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(800) });
    return response.status > 0;
  } catch {
    return false;
  }
}

function noticeFrom(spend: ProxySpend): TurnNotice {
  return {
    id: spend.id,
    conversationId: "proxy",
    status: "completed",
    source: "proxy",
    model: spend.model,
    reducedTokens: spend.afterTokens,
    promptTokens: spend.usage?.promptTokens ?? spend.afterTokens,
    baselineTokens: spend.beforeTokens,
    userBefore: 0,
    userAfter: 0,
    harnessBefore: 0,
    harnessAfter: 0,
    actualPromptTokens: spend.usage?.promptTokens,
    actualCompletionTokens: spend.usage?.completionTokens,
    keptTools: spend.keptTools,
    droppedTools: spend.droppedTools,
  };
}

function readNotice(file: string): TurnNotice | null {
  try {
    const notice = JSON.parse(fs.readFileSync(file, "utf8")) as TurnNotice;
    if (!notice || typeof notice.id !== "string" || typeof notice.promptTokens !== "number") {
      return null;
    }
    return notice;
  } catch {
    return null;
  }
}

export function deactivate(): void {}
