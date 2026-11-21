import fs from "fs";
import os from "os";
import path from "path";

export type EndpointRecord = { port: number; token: string };

export type IdeHookResponse = { continue: true } | { continue: false; user_message: string };

export type IdeHost = "cursor" | "vscode" | "other";

export type CursorHookSync = "install" | "remove" | "keep";

export function detectIdeHost(appName: string, uriScheme: string): IdeHost {
  const scheme = uriScheme.trim().toLowerCase();
  const name = appName.trim().toLowerCase();
  if (scheme === "cursor" || name === "cursor" || name.startsWith("cursor ")) {
    return "cursor";
  }
  if (scheme === "vscode" || scheme === "vscode-insiders" || name.includes("visual studio code")) {
    return "vscode";
  }
  return "other";
}

export function ideHostLabel(host: IdeHost): string {
  if (host === "cursor") {
    return "Cursor";
  }
  if (host === "vscode") {
    return "VS Code";
  }
  return "this editor";
}

export function cursorEndpointFile(): string {
  return path.join(os.homedir(), ".cursor", "tokenpilot", "endpoint-cursor.json");
}

export function defaultEndpointFile(): string {
  return cursorEndpointFile();
}

export function legacyEndpointFile(): string {
  return path.join(os.homedir(), ".cursor", "tokenpilot", "endpoint.json");
}

export function endpointFileExists(file: string): boolean {
  return fs.existsSync(file);
}

export function removeLegacyEndpoint(): void {
  try {
    fs.unlinkSync(legacyEndpointFile());
  } catch {
    return;
  }
}

// Cursor publishes an endpoint only while it is enabled. Another IDE must not
// install the hook, and must not remove a hook Cursor is still using.
export function cursorHookSync(host: IdeHost, enabledHere: boolean, endpointPresent: boolean): CursorHookSync {
  if (host === "cursor" && enabledHere) {
    return "install";
  }
  if (!endpointPresent) {
    return "remove";
  }
  return "keep";
}

export function writeEndpoint(file: string, record: EndpointRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

export function clearEndpoint(file: string, token: string): boolean {
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: unknown };
    if (current.token !== token) {
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export async function decideIdeHook(input: {
  endpointFile: string;
  prompt: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<IdeHookResponse> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    return { continue: true };
  }
  const endpoint = readEndpoint(input.endpointFile);
  if (!endpoint) {
    return { continue: true };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${endpoint.port}/tokenpilot/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ prompt, conversationId: input.conversationId }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 80_000),
    });
    if (!response.ok) {
      return { continue: true };
    }
    const body = (await response.json()) as { ok?: unknown; content?: unknown };
    if (body.ok !== true) {
      return { continue: true };
    }
    const content = typeof body.content === "string" && body.content.trim() ? body.content : "TokenPilot handled this turn.";
    return { continue: false, user_message: content };
  } catch {
    return { continue: true };
  }
}

function readEndpoint(file: string): EndpointRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof parsed.port !== "number" || !Number.isFinite(parsed.port) || typeof parsed.token !== "string" || !parsed.token) {
      return null;
    }
    return { port: parsed.port, token: parsed.token };
  } catch {
    return null;
  }
}
