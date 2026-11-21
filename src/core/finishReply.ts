import fs from "fs";
import path from "path";
import { inferToolTags, reviewToolCall } from "./harness";

export type ToolCall = { id: string; name: string; arguments: string };

const FILE = /(?:`([^`]+\.[a-zA-Z0-9]+)`|(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]+))/g;

export function replyText(message: Record<string, unknown> | null, fallback = ""): string {
  const content = message?.content;
  if (typeof content === "string" && content.trim()) {
    return content;
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("")
      .trim();
    if (joined) {
      return joined;
    }
  }
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) {
    return reasoning;
  }
  return fallback.trim();
}

export function visibleText(message: Record<string, unknown> | null, fallback = ""): string {
  const text = replyText(message, "");
  if (text) {
    return text;
  }
  const calls = toolCallsFrom(message);
  if (calls.length > 0) {
    return calls.map((call) => `${call.name} ${call.arguments}`.trim()).join("\n");
  }
  return fallback.trim();
}

export function toolCallsFrom(message: Record<string, unknown> | null): ToolCall[] {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    if (!name) {
      continue;
    }
    calls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${calls.length + 1}`,
      name,
      arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
    });
  }
  return calls;
}

export function isDeferredPlan(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 700 || /```/.test(trimmed)) {
    return false;
  }
  const wantsFiles = /\b(read|inspect|look at|look|open|check|review|examine)\b/i.test(trimmed);
  const notDone = /\b(let's|let us|first|i'll|i will|then|as well|other files)\b/i.test(trimmed);
  return wantsFiles && notDone;
}

export function answerReady(text: string, calls: ToolCall[]): boolean {
  if (calls.length > 0 || isDeferredPlan(text)) {
    return false;
  }
  return text.trim().length > 0;
}

export function filesNamed(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(FILE)) {
    const name = (match[1] || match[2] || "").replace(/^\.\//, "");
    if (name && !found.includes(name)) {
      found.push(name);
    }
  }
  return found.slice(0, 8);
}

export function readWorkspaceFile(root: string, relative: string, startLine?: number, endLine?: number): string | null {
  const full = safePath(root, relative);
  if (!full) {
    return null;
  }
  const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? Math.min(lines.length, start + 399));
  return lines.slice(start - 1, end).join("\n").slice(0, 6000);
}

export function followUpForPlan(root: string, text: string): string {
  const named = filesNamed(text);
  const files = named.length > 0 ? named : sourceFiles(root).slice(0, 4);
  const scope = files.length > 0 ? ` Files in scope: ${files.join(", ")}.` : "";
  return `Give the final edit in this reply. Do not say you will read or check files. Do not paste a file that already satisfies the task.${scope}`;
}

function sourceFiles(root: string): string[] {
  if (!root) {
    return [];
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= 8) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 8 || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith(".ts")) {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "src"));
  return found;
}

export function toolResult(root: string, call: ToolCall): { role: "tool"; tool_call_id: string; content: string } {
  return { role: "tool", tool_call_id: call.id, content: runCall(root, call) };
}

function runCall(root: string, call: ToolCall): string {
  const review = reviewToolCall(call.name, false);
  if (!review.proceed) {
    return `${call.name} was not run. ${review.reason} Put the proposed change in the reply.`;
  }
  const args = parseArgs(call.arguments);
  const tags = inferToolTags(call.name);
  if (tags.includes("read") || tags.includes("graph")) {
    const file = stringArg(args, "path") || stringArg(args, "file");
    if (!file) {
      return "Read needs a path.";
    }
    const body = readWorkspaceFile(root, file, numberArg(args, "startLine"), numberArg(args, "endLine"));
    return body == null ? `Not found: ${file}` : body;
  }
  if (tags.includes("search")) {
    return searchWorkspace(root, stringArg(args, "query") || stringArg(args, "pattern") || "");
  }
  return `${call.name} is not run from this chat. Answer from the files already shown.`;
}

function searchWorkspace(root: string, query: string): string {
  if (!root || !query.trim()) {
    return "Search needs a query.";
  }
  const needle = query.trim().toLowerCase();
  const hits: string[] = [];
  const walk = (dir: string): void => {
    if (hits.length >= 20) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && full.endsWith(".ts")) {
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (hits.length < 20 && line.toLowerCase().includes(needle)) {
            hits.push(`${path.relative(root, full)}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
  };
  try {
    walk(root);
  } catch {
    return "Search failed.";
  }
  return hits.length > 0 ? hits.join("\n") : "No matches.";
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePath(root: string, relative: string): string | null {
  if (!root || !relative.trim()) {
    return null;
  }
  const base = path.resolve(root);
  const full = path.resolve(base, relative.trim());
  if (full !== base && !full.startsWith(base + path.sep)) {
    return null;
  }
  try {
    if (!fs.statSync(full).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return full;
}
