import { GraphIndex, scopeNote } from "./graph";
import { alignObjective } from "./objective";
import { reduceProviderPayload } from "./reduce";
import { routeTurn, type ModelIds, type TaskKind } from "./route";
import { countTokens } from "./tokens";
import { fetchTavilyPack, needsExternalFact, tavilyQuery } from "./tavily";
import type { ChatMessage } from "./types";

export type TurnMessage = Record<string, unknown> & { role?: unknown; content?: unknown };

export type PreparedTurn = {
  blocked: boolean;
  notice: string | null;
  via: "local" | "bifrost" | "none";
  model: string | null;
  fallbacks: string[];
  messages: TurnMessage[];
  tools: unknown;
  maxTokens: number;
  reasoningEffort?: "low" | "medium";
  goal: string;
  scope: string;
  urls: string[];
  task: TaskKind;
  promptBefore: number;
  promptAfter: number;
  actions: string[];
};

export type PrepareInput = {
  body: Record<string, unknown>;
  workspaceRoot: string;
  models: ModelIds;
  confidential: boolean;
  budgetRemainingUsd: number;
  providerUp: boolean;
  tavilyKey: string;
  optimize: boolean;
  lockModel: boolean;
  fetchImpl?: typeof fetch;
};

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
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

function lastUserText(messages: TurnMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return textOf(messages[index].content);
    }
  }
  return "";
}

function asMessages(value: unknown): TurnMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is TurnMessage => Boolean(item) && typeof item === "object");
}

function plain(messages: TurnMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role === "system" || message.role === "assistant" ? message.role : "user",
    content: textOf(message.content),
  }));
}

function reattach(aligned: ChatMessage[], source: TurnMessage[]): TurnMessage[] {
  return aligned.map((message, index) => {
    const original = source[index] ?? {};
    const extra: TurnMessage = {};
    for (const [key, value] of Object.entries(original)) {
      if (key !== "role" && key !== "content") {
        extra[key] = value;
      }
    }
    const role = typeof original.role === "string" ? original.role : message.role;
    const content = role === "system" ? message.content : (original.content ?? message.content);
    return { ...extra, role, content };
  });
}

function countMessages(messages: TurnMessage[], tools: unknown): number {
  const text = messages.map((message) => textOf(message.content)).join("\n");
  return countTokens(`${text}\n${JSON.stringify(tools ?? [])}`);
}

export async function prepareTurn(input: PrepareInput): Promise<PreparedTurn> {
  const incoming = asMessages(input.body.messages);
  const userText = lastUserText(incoming);
  const requested = typeof input.body.model === "string" && input.body.model.trim() ? input.body.model.trim() : input.models.strong;
  const promptBefore = countMessages(incoming, input.body.tools);

  if (!input.optimize) {
    const decision = routeTurn({
      confidential: input.confidential,
      taskKind: "edit",
      promptTokens: promptBefore,
      budgetRemainingUsd: input.budgetRemainingUsd,
      providerUp: input.providerUp,
      models: { ...input.models, strong: input.lockModel ? requested : input.models.strong, small: input.lockModel ? requested : input.models.small },
    });
    const model = input.confidential ? decision.model : input.lockModel ? requested : decision.model;
    return {
      blocked: decision.blocked,
      notice: decision.notifyUser,
      via: decision.blocked ? "none" : input.confidential ? "local" : "bifrost",
      model,
      fallbacks: input.lockModel || input.confidential ? [] : decision.fallbacks,
      messages: incoming,
      tools: input.body.tools,
      maxTokens: typeof input.body.max_tokens === "number" ? input.body.max_tokens : 800,
      goal: userText.slice(0, 240),
      scope: "",
      urls: [],
      task: "edit",
      promptBefore,
      promptAfter: promptBefore,
      actions: ["Optimization off. The IDE body was forwarded unchanged."],
    };
  }

  let files: string[] = [];
  let scope = "";
  if (input.workspaceRoot) {
    const index = new GraphIndex();
    index.load(input.workspaceRoot);
    const hit = index.queryText(userText);
    files = hit.files;
    scope = scopeNote(hit.symbols, userText);
  }
  const reduced = reduceProviderPayload(input.body);
  const reducedMessages = asMessages(reduced.payload.messages);
  let evidence = "";
  const urls: string[] = [];
  const actions: string[] = [];
  if (needsExternalFact(textOf(reducedMessages.find((message) => message.role === "user")?.content ?? userText), "")) {
    if (!input.tavilyKey) {
      actions.push("Tavily key is not set. This turn will not search.");
    } else {
      try {
        const pack = await fetchTavilyPack(tavilyQuery(userText), input.tavilyKey, input.fetchImpl);
        evidence = pack.text;
        urls.push(...pack.urls);
      } catch (error) {
        actions.push(error instanceof Error ? error.message : "Tavily search failed.");
      }
    }
  }
  const aligned = alignObjective(plain(reducedMessages), {
    task: reduced.task,
    userText: textOf(reducedMessages.filter((message) => message.role === "user").at(-1)?.content ?? userText),
    files,
    evidence,
    scope,
  });
  const messages = reattach(aligned.messages, reducedMessages);
  const sendTools = reduced.task === "edit" && scope ? undefined : reduced.payload.tools;
  const promptAfter = countMessages(messages, sendTools ?? []);
  const decision = routeTurn({
    confidential: input.confidential,
    taskKind: reduced.task,
    promptTokens: promptAfter,
    budgetRemainingUsd: input.budgetRemainingUsd,
    providerUp: input.providerUp,
    models: input.lockModel
      ? { local: input.models.local, small: requested, strong: requested }
      : input.models,
  });
  const model = decision.blocked ? null : input.confidential || !input.lockModel ? decision.model : requested;
  return {
    blocked: decision.blocked,
    notice: decision.notifyUser,
    via: decision.blocked ? "none" : decision.via,
    model,
    fallbacks: input.lockModel || input.confidential ? [] : decision.fallbacks,
    messages,
    tools: sendTools,
    maxTokens: aligned.maxTokens,
    reasoningEffort: aligned.reasoning === "none" ? undefined : aligned.reasoning,
    goal: aligned.goal,
    scope,
    urls,
    task: reduced.task,
    promptBefore,
    promptAfter,
    actions: [...actions, ...aligned.actions, `Input ${reduced.beforeTokens} → ${reduced.afterTokens}.`],
  };
}
