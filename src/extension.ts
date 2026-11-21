import fs from "fs";
import os from "os";
import path from "path";
import * as vscode from "vscode";
import { formatTokenNotice, type TurnNotice } from "./core/cursorTurn";
import { installCursorHook } from "./installHooks";
import { BenchView, TokenPilotSession } from "./session";

export function activate(context: vscode.ExtensionContext): void {
  const session = new TokenPilotSession(context);
  const tokenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  tokenStatus.command = "tokenpilot.open";
  tokenStatus.text = "$(symbol-number) TokenPilot";
  tokenStatus.tooltip = "Input token count for the last Cursor chat turn";
  tokenStatus.show();

  context.subscriptions.push(
    session.statusBar,
    tokenStatus,
    vscode.commands.registerCommand("tokenpilot.open", () => session.openPanel()),
    vscode.commands.registerCommand("tokenpilot.reindex", () => session.reindex()),
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
    vscode.window.registerWebviewViewProvider("tokenpilot.benchView", new BenchView(session)),
    vscode.workspace.onDidSaveTextDocument((document) => session.onSave(document)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => session.reindex()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenpilot")) {
        session.publishState();
      }
    }),
  );
  session.reindex();

  try {
    installCursorHook(context.extensionPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "TokenPilot could not register its chat hook.";
    tokenStatus.text = "$(warning) TokenPilot";
    tokenStatus.tooltip = message;
  }

  const latest = path.join(os.homedir(), ".cursor", "tokenpilot", "latest.json");
  let seen = readNotice(latest)?.id ?? "";
  const show = (): void => {
    const notice = readNotice(latest);
    if (!notice || notice.id === seen || !Number.isFinite(notice.promptTokens)) {
      return;
    }
    seen = notice.id;
    const text = formatTokenNotice(notice);
    tokenStatus.text = `$(symbol-number) Reduced input: ${notice.promptTokens.toLocaleString("en-US")}`;
    tokenStatus.tooltip = text;
    void vscode.window.showInformationMessage(text);
  };
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.watchFile(latest, { interval: 400 }, show);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(latest, show) });
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
