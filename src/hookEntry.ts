import fs from "fs";
import os from "os";
import path from "path";
import { applyCursorHook, measureReducedTurn, type PendingTurns } from "./core/cursorTurn";
import { decideIdeHook, defaultEndpointFile } from "./core/ideClient";

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
  if (input.hook_event_name === "beforeSubmitPrompt") {
    const decision = await decideIdeHook({
      endpointFile: defaultEndpointFile(),
      prompt: String(input.prompt ?? ""),
      conversationId: String(input.conversation_id ?? "default"),
    });
    if (!decision.continue) {
      const conversationId = String(input.conversation_id ?? "default");
      if (pending[conversationId]) {
        const rest = { ...pending };
        delete rest[conversationId];
        writeJson(pendingPath, rest);
      }
      process.stdout.write(JSON.stringify(decision));
      return;
    }
  }
  const measured = input.hook_event_name === "beforeSubmitPrompt" ? measureReducedTurn(String(input.prompt ?? "")) : undefined;
  const result = applyCursorHook(input, pending, Date.now(), measured);
  writeJson(pendingPath, result.pending);
  process.stdout.write(JSON.stringify(result.response));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.stdout.write("{}");
});
