import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

type HookCommand = { command: string; timeout?: number };
type HooksFile = { version: number; hooks: Record<string, HookCommand[]> };

const EVENTS = ["beforeSubmitPrompt", "stop"];

export function defaultHooksPath(): string {
  return path.join(os.homedir(), ".cursor", "hooks.json");
}

export function installCursorHook(extensionPath: string, hooksPath = defaultHooksPath()): string {
  const script = path.join(extensionPath, "dist", "turn-hook.js");
  const node = findNode();
  const command = `"${node}" "${script}"`;
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const current = readHooks(hooksPath);
  for (const event of EVENTS) {
    const kept = (current.hooks[event] ?? []).filter((hook) => !isTokenPilotHook(hook.command));
    current.hooks[event] = [...kept, { command, timeout: 90 }];
  }
  fs.writeFileSync(hooksPath, JSON.stringify(current, null, 2));
  return command;
}

export function removeCursorHook(hooksPath = defaultHooksPath()): void {
  if (!fs.existsSync(hooksPath)) {
    return;
  }
  const current = readHooks(hooksPath);
  let changed = false;
  for (const event of Object.keys(current.hooks)) {
    const hooks = current.hooks[event] ?? [];
    const kept = hooks.filter((hook) => !isTokenPilotHook(hook.command));
    if (kept.length === hooks.length) {
      continue;
    }
    changed = true;
    if (kept.length === 0) {
      delete current.hooks[event];
    } else {
      current.hooks[event] = kept;
    }
  }
  if (changed) {
    fs.writeFileSync(hooksPath, JSON.stringify(current, null, 2));
  }
}

function isTokenPilotHook(command: string): boolean {
  return command.includes("turn-hook.js");
}

function readHooks(hooksPath: string): HooksFile {
  if (!fs.existsSync(hooksPath)) {
    return { version: 1, hooks: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as Partial<HooksFile>;
  return {
    version: 1,
    hooks: parsed.hooks && typeof parsed.hooks === "object" ? parsed.hooks : {},
  };
}

function findNode(): string {
  const fromPath = execFileSync("/bin/zsh", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
  if (!fromPath) {
    throw new Error("node was not found on PATH");
  }
  return fromPath;
}
