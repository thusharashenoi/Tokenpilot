import { harnessFor } from "./agents";
import { sendViaBifrost } from "./bifrost";
import { replyText } from "./finishReply";
import { GraphIndex, scopeNote } from "./graph";
import { toOpenAITools } from "./harness";
import { holdExistingSignatures, rewriteReply, stateNoEdit } from "./rewrite";
import { countTokens } from "./tokens";
import { encodeJsonBlocks } from "./toon";
import { DEFAULT_REWRITE_MODEL, traceUserPrompt, type RewriteOptions, type RewriteTrace } from "./userPrompt";

const GREETING = /^(?:hi|hello|hey|hiya|yo|hi there|hello there|hey there|good morning|good afternoon|good evening|thanks|thank you)[!.?\s]*$/i;

export function isGreeting(text: string): boolean {
  return GREETING.test(text.trim());
}

export const GREETING_HARNESS = "Answer the user directly. A greeting gets one short greeting.";

export const CUSTOM_HARNESS = [
  "You are a coding agent in this repository.",
  "Make the smallest change that satisfies the task.",
  "Keep every constraint, path, number, and named signature exact.",
  "Never log secrets, tokens, or card numbers.",
  "If the existing code already does the task, answer that no edit is required and put each existing signature on its own line.",
  "Answer with the decision, then the patch. Do not restate the task.",
  "Do not invent files, functions, or parameters the task did not name.",
  "Do not greet, list considerations, or ask for permission instead of the answer.",
  "A structured block marked TOON is tabular data, not a file to rewrite.",
].join(" ");

export type CustomPrompt = {
  system: string;
  user: string;
  promptBefore: number;
  promptAfter: number;
  stages: string;
};

export function stageLabel(source: RewriteTrace["source"] | "skipped", toonSaved: number): string {
  const rewrite =
    source === "kept"
      ? "ollama kept the draft"
      : source === "dropped"
        ? "ollama ran, draft dropped"
        : source === "failed"
          ? "ollama failed, condenser kept"
          : "ollama skipped";
  return `${rewrite}, toon ${toonSaved}`;
}

function cursorRequestTokens(task: string): number {
  const harness = harnessFor("cursor");
  return countTokens(`${harness.systemPrompt}\n${task}\n${JSON.stringify(toOpenAITools(harness.tools))}`);
}

export function signaturesFor(workspaceRoot: string, task: string): string {
  if (!workspaceRoot) {
    return "";
  }
  const index = new GraphIndex();
  index.load(workspaceRoot);
  return scopeNote(index.queryText(task).symbols, task);
}

function greetingReply(task: string, modelText: string): string {
  const clean = modelText.trim();
  if (clean && !/no edit is required/i.test(clean)) {
    return clean;
  }
  const word = task.trim().replace(/[!.?\s]+$/g, "");
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}.`;
}

export async function buildCustomPrompt(task: string, options: RewriteOptions = {}, scope = ""): Promise<CustomPrompt> {
  if (isGreeting(task)) {
    const user = task.trim();
    return {
      system: GREETING_HARNESS,
      user,
      promptBefore: cursorRequestTokens(task),
      promptAfter: countTokens(`${GREETING_HARNESS}\n${user}`),
      stages: stageLabel("skipped", 0),
    };
  }
  const traced = await traceUserPrompt(task, options);
  const packed = encodeJsonBlocks(traced.text);
  const user = [packed.text.trim() || traced.text.trim() || task.trim(), scope.trim()].filter(Boolean).join("\n\n");
  return {
    system: CUSTOM_HARNESS,
    user,
    promptBefore: cursorRequestTokens(task),
    promptAfter: countTokens(`${CUSTOM_HARNESS}\n${user}`),
    stages: stageLabel(traced.source, packed.saved),
  };
}

function lastUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return "";
}

export async function runCustomHarness(input: {
  task: string;
  localUrl: string;
  rewriteModel?: string;
  bifrostUrl: string;
  bifrostPath: string;
  model: string;
  workspaceRoot?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const greeting = isGreeting(input.task);
  const scope = greeting ? "" : signaturesFor(input.workspaceRoot ?? "", input.task);
  const prepared = await buildCustomPrompt(input.task, {
    url: input.localUrl,
    model: input.rewriteModel || DEFAULT_REWRITE_MODEL,
    fetchImpl: input.fetchImpl,
  }, scope);
  const result = await sendViaBifrost({
    via: "bifrost",
    baseUrl: input.bifrostUrl,
    path: input.bifrostPath,
    model: input.model,
    fallbacks: [],
    messages: [
      { role: "system", content: prepared.system },
      { role: "user", content: prepared.user },
    ],
    maxTokens: 800,
    fetchImpl: input.fetchImpl,
    logLabels: { arm: "custom-harness", source: "tokenpilot" },
  });
  const visible = replyText(result.message, result.content);
  const rewritten = greeting ? null : rewriteReply(visible, prepared.user);
  const text = greeting
    ? greetingReply(input.task, visible)
    : stateNoEdit(holdExistingSignatures(rewritten?.text ?? visible, scope), scope);
  const storedTokens = countTokens(text);
  const completion = result.usage?.completionTokens ?? storedTokens;
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "x-tokenpilot-prompt-before": String(prepared.promptBefore),
      "x-tokenpilot-prompt-after": String(prepared.promptAfter),
      "x-tokenpilot-completion": String(completion),
      "x-tokenpilot-stored": String(storedTokens),
      "x-tokenpilot-notice": result.notifyUser ?? "",
      "x-tokenpilot-stages": prepared.stages,
    },
    body: {
      id: "tokenpilot",
      object: "chat.completion",
      model: result.modelUsed,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: {
        prompt_tokens: prepared.promptAfter,
        completion_tokens: completion,
      },
    },
  };
}

export function customTaskFrom(body: Record<string, unknown>): string {
  return lastUserText(body);
}
