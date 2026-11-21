import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { formatTokenNotice, type TurnNotice } from "./core/cursorTurn";
import {
  clearEndpoint,
  cursorEndpointFile,
  cursorHookSync,
  detectIdeHost,
  endpointFileExists,
  ideHostLabel,
  removeLegacyEndpoint,
  writeEndpoint,
} from "./core/ideClient";
import type { ProxySpend } from "./core/proxy";
import { listGatewayModels, pickCatalogModel } from "./core/modelCatalog";
import { DEFAULT_REWRITE_MODEL, rewriteUserPrompt } from "./core/userPrompt";
import { installCursorHook, removeCursorHook } from "./installHooks";
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
  const host = detectIdeHost(vscode.env.appName, vscode.env.uriScheme);
  const endpointFile = cursorEndpointFile();
  let seen = readNotice(latest)?.id ?? "";
  let running: RunningProxy | undefined;
  let proxyUrl = "";
  let generation = 0;

  const syncCursorHook = (activePort: number | null): void => {
    const enabledHere = host === "cursor" && activePort !== null;
    if (enabledHere) {
      writeEndpoint(endpointFile, { port: activePort, token: ideToken });
    } else if (host === "cursor") {
      clearEndpoint(endpointFile, ideToken);
    }
    const action = cursorHookSync(host, enabledHere, endpointFileExists(endpointFile));
    try {
      if (action === "install") {
        installCursorHook(context.extensionPath);
      } else if (action === "remove") {
        removeCursorHook();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "TokenPilot could not update its Cursor hook.";
      output.appendLine(message);
    }
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
    if (host === "cursor") {
      clearEndpoint(endpointFile, ideToken);
    }
    const config = vscode.workspace.getConfiguration("tokenpilot");
    if (!config.get<boolean>("proxyEnabled", true)) {
      syncCursorHook(null);
      tokenStatus.text = "$(debug-disconnect) TokenPilot proxy off";
      tokenStatus.tooltip = `TokenPilot is off in ${ideHostLabel(host)}. Other open editors stay unchanged.`;
      return;
    }
    const port = config.get<number>("proxyPort", 8787);
    const upstream = config.get<string>("bifrostUrl") || "http://localhost:8080";
    const key = config.get<string>("bifrostKey")?.trim() ?? "";
    const rewriteUrl = config.get<string>("localUrl") || "http://127.0.0.1:11434";
    const rewriteModel = config.get<string>("rewriteModel") || DEFAULT_REWRITE_MODEL;
    const options = {
      upstream,
      key,
      rewriteUser: (text: string) => rewriteUserPrompt(text, { url: rewriteUrl, model: rewriteModel }),
      pickModel: async (text: string) => {
        const available = await listGatewayModels(upstream);
        if (!available) {
          return null;
        }
        const picked = pickCatalogModel(text, available);
        return picked ? { model: picked.model, fallbacks: picked.fallbacks } : null;
      },
      onSpend: (spend: ProxySpend) => publish(noticeFrom(spend)),
      ideToken,
      onIdeTurn: (input: { prompt: string }, signal?: AbortSignal) => session.handleIdePrompt(input.prompt, signal),
    };
    const showRunning = (startedPort: number, requestedPort: number): void => {
      proxyUrl = `http://127.0.0.1:${startedPort}/v1`;
      syncCursorHook(host === "cursor" ? startedPort : null);
      tokenStatus.text = `$(plug) TokenPilot :${startedPort}`;
      const moved = startedPort === requestedPort ? "" : ` Port ${requestedPort} was already taken, so this window is using ${startedPort}.`;
      if (host === "cursor") {
        tokenStatus.tooltip = `Cursor chat in this window is handled on port ${startedPort}.${moved}`;
        output.appendLine(`Extension listening on ${proxyUrl}. Only Cursor chat is hooked, and only while TokenPilot is enabled here.${moved}`);
      } else {
        tokenStatus.tooltip = `TokenPilot is on in this ${ideHostLabel(host)} window. Cursor chat is not hooked.${moved}`;
        output.appendLine(
          `Extension listening on ${proxyUrl}. This ${ideHostLabel(host)} window is using TokenPilot. Other editors are left alone.${moved}`,
        );
      }
    };
    try {
      let started: RunningProxy;
      try {
        started = await startProxy({ ...options, port });
      } catch (error) {
        if (!isAddrInUse(error) || ticket !== generation) {
          throw error;
        }
        started = await startProxy({ ...options, port: 0 });
      }
      if (ticket !== generation) {
        await started.close();
        return;
      }
      running = started;
      showRunning(running.port, port);
    } catch (error) {
      if (ticket !== generation) {
        return;
      }
      syncCursorHook(null);
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
    vscode.commands.registerCommand("tokenpilot.proxyUrl", async () => {
      if (!proxyUrl) {
        const tip = tokenStatus.tooltip;
        void vscode.window.showWarningMessage(typeof tip === "string" ? tip : "The TokenPilot proxy is not listening.");
        return;
      }
      const models = vscode.workspace.getConfiguration("tokenpilot");
      const small = models.get<string>("smallModel") || "openai/gpt-4o-mini";
      const strong = models.get<string>("strongModel") || "openai/gpt-4o";
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
        syncCursorHook(null);
        void running?.close();
      },
    },
  );
  removeLegacyEndpoint();
  if (host !== "cursor") {
    syncCursorHook(null);
  }

  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.watchFile(latest, { interval: 400 }, showFile);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(latest, showFile) });
  void start();
}

function isAddrInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EADDRINUSE");
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
