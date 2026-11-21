import { inferToolTags, stripHarness, type ToolDef, type ToolTag } from "./harness";
import { compactProse } from "./nlp";
import type { TaskKind } from "./route";
import { countTokens } from "./tokens";
import { encodeJsonBlocks } from "./toon";

const APPROVAL = new Set<ToolTag>(["edit", "shell", "git"]);

export type ReduceReport = {
  task: TaskKind;
  beforeTokens: number;
  afterTokens: number;
  saved: number;
  savedPct: number;
  keptTools: string[];
  droppedTools: string[];
  payload: Record<string, unknown>;
};

type Msg = { role: string; content: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object") {
        const record = part as { text?: unknown; content?: unknown };
        if (typeof record.text === "string") {
          return record.text;
        }
        if (typeof record.content === "string") {
          return record.content;
        }
      }
      return "";
    })
    .join("");
}

function writeText(original: unknown, text: string): unknown {
  if (typeof original === "string" || original == null) {
    return text;
  }
  if (!Array.isArray(original)) {
    return text;
  }
  const first = original.find((part) => part && typeof part === "object") as { type?: string } | undefined;
  const type = first?.type === "input_text" ? "input_text" : "text";
  return [{ type, text }];
}

function toolDef(name: string, description: string, parameters: unknown): ToolDef {
  const tags = inferToolTags(name);
  return {
    name,
    description,
    parameters: parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : undefined,
    tags,
    requiresApproval: tags.some((tag) => APPROVAL.has(tag)),
  };
}

function readTools(tools: unknown): { shape: "chat" | "flat"; def: ToolDef }[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const parsed = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }
    const record = tool as { type?: string; name?: unknown; description?: unknown; parameters?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    const fn = record.function ?? record;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) {
      continue;
    }
    parsed.push({
      shape: record.function ? "chat" as const : "flat" as const,
      def: toolDef(name, typeof fn.description === "string" ? fn.description : "", fn.parameters),
    });
  }
  return parsed;
}

function emitTool(shape: "chat" | "flat", tool: ToolDef): unknown {
  const parameters = tool.parameters ?? { type: "object", properties: {} };
  if (shape === "chat") {
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
  }
  return { type: "function", name: tool.name, description: tool.description, parameters };
}

function readMessages(body: Record<string, unknown>): { kind: "chat" | "responses"; messages: Msg[] } {
  if (Array.isArray(body.messages)) {
    return {
      kind: "chat",
      messages: body.messages
        .filter((item): item is Msg => Boolean(item) && typeof item === "object" && typeof (item as Msg).role === "string")
        .map((item) => ({ role: item.role, content: item.content })),
    };
  }
  const messages: Msg[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as { role?: unknown; content?: unknown; text?: unknown };
      if (typeof record.role !== "string") {
        continue;
      }
      messages.push({ role: record.role, content: record.content ?? record.text ?? "" });
    }
  }
  return { kind: "responses", messages };
}

function groomUser(content: unknown, toon: boolean): unknown {
  const text = textOf(content);
  const groomed = compactProse(text);
  const next = toon ? encodeJsonBlocks(groomed).text : groomed;
  return writeText(content, next);
}

function measure(system: string, users: string[], tools: unknown): number {
  return countTokens(`${system}\n${users.join("\n")}\n${JSON.stringify(tools ?? [])}`);
}

export function reduceProviderPayload(body: Record<string, unknown>, graphPack = ""): ReduceReport {
  const parsed = readMessages(body);
  const incomingTools = readTools(body.tools);
  const systemRaw = parsed.messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join("\n\n");
  const userIndexes = parsed.messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  const lastUser = userIndexes.length > 0 ? userIndexes[userIndexes.length - 1] : -1;
  const groomedUsers = parsed.messages.map((message, index) =>
    message.role === "user" ? groomUser(message.content, index === lastUser) : message.content,
  );
  const taskText = lastUser >= 0 ? textOf(groomedUsers[lastUser]) : "";
  const stripped = stripHarness(systemRaw, incomingTools.map((tool) => tool.def), taskText);
  const pack = graphPack.trim();
  const system = pack ? `${stripped.systemPrompt}\n\n${pack}` : stripped.systemPrompt;
  const keptByName = new Map(stripped.tools.map((tool) => [tool.name, tool]));
  const shape = incomingTools.some((tool) => tool.shape === "chat") ? "chat" : "flat";
  const tools = stripped.tools.map((tool) => emitTool(shape, keptByName.get(tool.name) ?? tool));
  const nextMessages: Msg[] = [{ role: "system", content: system }];
  parsed.messages.forEach((message, index) => {
    if (message.role === "system") {
      return;
    }
    nextMessages.push({ role: message.role, content: message.role === "user" ? groomedUsers[index] : message.content });
  });
  const payload: Record<string, unknown> = { ...body };
  if (parsed.kind === "chat") {
    payload.messages = nextMessages;
  } else if (typeof body.input === "string") {
    payload.instructions = system;
    const user = nextMessages.find((message) => message.role === "user");
    payload.input = user ? textOf(user.content) : "";
  } else {
    payload.instructions = system;
    payload.input = nextMessages
      .filter((message) => message.role !== "system")
      .map((message) => ({ type: "message", role: message.role, content: message.content }));
  }
  if (body.tools !== undefined) {
    payload.tools = tools;
  }
  const beforeUsers = parsed.messages.filter((message) => message.role === "user").map((message) => textOf(message.content));
  const afterUsers = nextMessages.filter((message) => message.role === "user").map((message) => textOf(message.content));
  const beforeTokens = measure(systemRaw, beforeUsers, body.tools ?? []);
  const afterTokens = measure(system, afterUsers, payload.tools ?? []);
  const saved = beforeTokens - afterTokens;
  return {
    task: stripped.task,
    beforeTokens,
    afterTokens,
    saved,
    savedPct: beforeTokens === 0 ? 0 : Math.round((saved / beforeTokens) * 100),
    keptTools: stripped.tools.map((tool) => tool.name),
    droppedTools: stripped.dropped,
    payload,
  };
}
