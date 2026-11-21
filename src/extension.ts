import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { formatTokenNotice, type TurnNotice } from "./core/cursorTurn";
import { clearEndpoint, defaultEndpointFile, writeEndpoint } from "./core/ideClient";
import type { ProxySpend } from "./core/proxy";
import { listGatewayModels, pickCatalogModel } from "./core/modelCatalog";
import { DEFAULT_REWRITE_MODEL, rewriteUserPrompt } from "./core/userPrompt";
import { installCursorHook } from "./installHooks";
import { startProxy, type RunningProxy } from "./proxyServer";
import { BenchView, TokenPilotSession } from "./session";

const latest = path.join(os.homedir(), ".cursor", "tokenpilot", "latest.json");

export function activate(context: vscode.ExtensionContext): void {
  const session = new TokenPilotSession(context);
  const output = vscode.window.createOutputChannel("TokenPilot");
  const tokenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  tokenStatus.command = "tokenpilot.proxyUrl";
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
      });
      if (ticket !== generation) {
        await started.close();
        return;
      }
      running = started;
      proxyUrl = `http://127.0.0.1:${running.port}/v1`;
      writeEndpoint(endpointFile, { port: running.port, token: ideToken });
      tokenStatus.text = `$(plug) TokenPilot :${running.port}`;
      tokenStatus.tooltip = `IDE prompts are sent by this extension on port ${running.port}.`;
      output.appendLine(`Extension listening on ${proxyUrl}. IDE prompts are sent here, then forwarded to ${upstream}.`);
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
    vscode.commands.registerCommand("tokenpilot.open", () => session.openPanel()),
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
    vscode.window.registerWebviewViewProvider("tokenpilot.benchView", new BenchView(session)),
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
  try {
    installCursorHook(context.extensionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TokenPilot could not register its chat hook.";
    output.appendLine(message);
  }

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
