import { harnessFor } from "./agents";
import { stripHarness, type ToolDef } from "./harness";
import { countTokens } from "./tokens";
import { condenseUserPrompt } from "./userPrompt";

export type ReducedTurn = {
  promptTokens: number;
  baselineTokens: number;
  userBefore: number;
  userAfter: number;
  harnessBefore: number;
  harnessAfter: number;
};

export type PendingTurns = Record<string, ReducedTurn>;

export type TurnNotice = ReducedTurn & {
  id: string;
  conversationId: string;
  status: string;
  source?: "proxy";
  model?: string;
  reducedTokens?: number;
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
  keptTools?: string[];
  droppedTools?: string[];
};

export function measureReducedTurn(prompt: string): ReducedTurn {
  const harness = harnessFor("cursor");
  // Sync version for hook measurements (no distillation)
  const nlpBefore = countTokens(prompt);
  const compacted = condenseUserPrompt(prompt);
  const nlpAfter = countTokens(compacted);
  const harnessBefore = countTokens(harness.systemPrompt) + countToolTokens(harness.tools);
  const stripped = stripHarness(harness.systemPrompt, harness.tools, compacted);
  const harnessAfter = countTokens(stripped.systemPrompt) + countToolTokens(stripped.tools);
  const baseline = countTokens(harness.systemPrompt) + nlpBefore + countToolTokens(harness.tools);
  const optimized = countTokens(stripped.systemPrompt) + nlpAfter + countToolTokens(stripped.tools);
  
  return {
    promptTokens: optimized,
    baselineTokens: baseline,
    userBefore: nlpBefore,
    userAfter: nlpAfter,
    harnessBefore,
    harnessAfter,
  };
}

function countToolTokens(tools: ToolDef[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return countTokens(tools.map((tool) => `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters ?? {})}`).join("\n"));
}

export function applyCursorHook(
  input: Record<string, unknown>,
  pending: PendingTurns,
  now: number,
  measured?: ReducedTurn,
): { response: Record<string, unknown>; pending: PendingTurns; notice: TurnNotice | null } {
  const event = String(input.hook_event_name ?? "");
  const conversationId = String(input.conversation_id ?? "default");
  if (event === "beforeSubmitPrompt") {
    const turn = measured ?? measureReducedTurn(String(input.prompt ?? ""));
    return {
      response: { continue: true },
      pending: { ...pending, [conversationId]: turn },
      notice: null,
    };
  }
  if (event === "stop") {
    const saved = pending[conversationId];
    const status = String(input.status ?? "completed");
    if (!saved || status === "error") {
      return { response: {}, pending, notice: null };
    }
    return {
      response: {},
      pending,
      notice: {
        id: `${conversationId}:${now}`,
        conversationId,
        status,
        ...saved,
      },
    };
  }
  return { response: {}, pending, notice: null };
}

function nameList(names: string[] | undefined): string {
  if (!names || names.length === 0) {
    return "";
  }
  if (names.length <= 6) {
    return names.join(", ");
  }
  return `${names.slice(0, 6).join(", ")} +${names.length - 6}`;
}

export function formatTokenNotice(turn: Partial<TurnNotice> & { promptTokens: number }): string {
  if (turn.source === "proxy") {
    const model = turn.model ? ` on ${turn.model}` : "";
    const reduced = turn.reducedTokens ?? turn.promptTokens;
    const before = turn.baselineTokens ?? reduced;
    const spent =
      typeof turn.actualPromptTokens === "number"
        ? `Spent ${turn.actualPromptTokens.toLocaleString("en-US")} input tokens and ${(turn.actualCompletionTokens ?? 0).toLocaleString("en-US")} output tokens${model}.`
        : `The provider did not return usage${model}.`;
    const tools = [
      turn.keptTools && turn.keptTools.length > 0 ? `Kept ${nameList(turn.keptTools)}.` : "",
      turn.droppedTools && turn.droppedTools.length > 0 ? `Dropped ${nameList(turn.droppedTools)}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return [`${spent} Stripped the request from ${before.toLocaleString("en-US")} to ${reduced.toLocaleString("en-US")} tokens.`, tools]
      .filter(Boolean)
      .join(" ");
  }
  if (
    turn.baselineTokens == null ||
    turn.userBefore == null ||
    turn.userAfter == null ||
    turn.harnessBefore == null ||
    turn.harnessAfter == null
  ) {
    return `Input tokens: ${turn.promptTokens.toLocaleString("en-US")}`;
  }
  return [
    `Reduced input: ${turn.promptTokens.toLocaleString("en-US")} tokens (was ${turn.baselineTokens.toLocaleString("en-US")})`,
    `Prompt ${turn.userBefore.toLocaleString("en-US")}→${turn.userAfter.toLocaleString("en-US")}`,
    `System and tools ${turn.harnessBefore.toLocaleString("en-US")}→${turn.harnessAfter.toLocaleString("en-US")}`,
  ].join(". ") + ".";
}
