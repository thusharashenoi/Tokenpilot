import fs from "fs";
import os from "os";
import path from "path";
import { applyCursorHook, measureReducedTurn, type PendingTurns, type ReducedTurn } from "./core/cursorTurn";
import { GraphIndex } from "./core/graph";

function stateDir(): string {
  return process.env.TOKENPILOT_STATE_DIR || path.join(os.homedir(), ".cursor", "tokenpilot");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: Record<string, unknown> = {};
  try {
    input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    input = {};
  }
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const pendingPath = path.join(dir, "pending.json");
  const pending = readJson<PendingTurns>(pendingPath, {});
  const measured = input.hook_event_name === "beforeSubmitPrompt" ? measureWorkspace(input) : undefined;
  const result = applyCursorHook(input, pending, Date.now(), measured);
  writeJson(pendingPath, result.pending);
  if (result.notice) {
    writeJson(path.join(dir, "latest.json"), result.notice);
  }
  process.stdout.write(JSON.stringify(result.response));
}

function measureWorkspace(input: Record<string, unknown>): ReducedTurn {
  const roots = input.workspace_roots;
  const root = Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : process.env.CURSOR_PROJECT_DIR || "";
  let graphPack = "";
  let fullFileTokens = 0;
  if (root) {
    const index = new GraphIndex();
    index.load(root);
    const hit = index.queryText(String(input.prompt ?? ""));
    graphPack = hit.pack;
    fullFileTokens = hit.fullFileTokens;
  }
  return measureReducedTurn(String(input.prompt ?? ""), graphPack, fullFileTokens);
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.stdout.write("{}");
});
