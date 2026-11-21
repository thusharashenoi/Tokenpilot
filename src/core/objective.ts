import { MAX_OUTPUT_TOKENS, type TaskKind } from "./route";
import type { ChatMessage } from "./types";

export type ReasoningEffort = "none" | "low" | "medium";

export type AlignedTurn = {
  messages: ChatMessage[];
  goal: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
  actions: string[];
};

const RULES = [
  "Answer first. One idea per sentence.",
  "Drop greetings, recap, and filler.",
  "Keep negations and numbers exact.",
  "Leave code, diffs, commands, and errors unchanged.",
  "Approval and budget text stay full sentences.",
].join(" ");

export function reasoningFor(task: TaskKind, hasEvidence: boolean): ReasoningEffort {
  if (hasEvidence || task === "lookup") {
    return "none";
  }
  if (task === "edit") {
    return "low";
  }
  return "medium";
}

export function maxTokensFor(effort: ReasoningEffort): number {
  if (effort === "none") {
    return 320;
  }
  if (effort === "low") {
    return 500;
  }
  return MAX_OUTPUT_TOKENS;
}

function goalFrom(userText: string): string {
  const line = userText
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !/^(hey|hi|hello|thanks|thank you)\b/i.test(item));
  return (line ?? userText).replace(/\s+/g, " ").trim().slice(0, 240);
}

function constraintsFrom(userText: string): string[] {
  return userText
    .replace(/```[\s\S]*?```/g, "\n")
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => /\b(don't|do not|never|must not|without)\b/i.test(item))
    .slice(0, 3);
}

/**
 * Appended after optimizeInput. distillHarness drops response-style headings,
 * so this contract must not go through that pass.
 */
export function alignObjective(
  messages: ChatMessage[],
  input: { task: TaskKind; userText: string; files?: string[]; evidence?: string },
): AlignedTurn {
  const goal = goalFrom(input.userText);
  const constraints = constraintsFrom(input.userText);
  const evidence = input.evidence?.trim() ?? "";
  const reasoning = reasoningFor(input.task, evidence.length > 0);
  const maxTokens = maxTokensFor(reasoning);
  const lines = [
    "Objective.",
    `Goal: ${goal}`,
    input.files && input.files.length > 0 ? `In scope: ${input.files.slice(0, 6).join(", ")}` : "",
    constraints.length > 0 ? `Constraints: ${constraints.join(" ")}` : "",
    "Done when that goal is met and nothing outside it changed.",
    RULES,
    evidence ? `Use only these sources. Do not add other URLs.\n${evidence}` : "",
  ].filter(Boolean);
  const suffix = lines.join("\n");
  const next = messages.map((message) => ({ ...message }));
  const system = next.find((message) => message.role === "system");
  if (system) {
    system.content = `${system.content}\n\n${suffix}`;
  } else {
    next.unshift({ role: "system", content: suffix });
  }
  const actions = [`Objective contract appended. Reasoning ${reasoning}. Output cap ${maxTokens}.`];
  if (evidence) {
    actions.push("External facts came from Tavily. Reasoning is off.");
  }
  return { messages: next, goal, reasoning, maxTokens, actions };
}
