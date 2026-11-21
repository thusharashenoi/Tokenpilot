import { harnessFor } from "./agents";
import { optimizeInput } from "./optimize";

export type ReducedTurn = {
  promptTokens: number;
  baselineTokens: number;
  userBefore: number;
  userAfter: number;
  harnessBefore: number;
  harnessAfter: number;
  graphPack: number;
  fullFiles: number;
};

export type PendingTurns = Record<string, ReducedTurn>;

export type TurnNotice = ReducedTurn & {
  id: string;
  conversationId: string;
  status: string;
};

export function measureReducedTurn(prompt: string, graphPack: string, fullFileTokens: number): ReducedTurn {
  const harness = harnessFor("cursor");
  const report = optimizeInput({
    systemPrompt: harness.systemPrompt,
    userText: prompt,
    tools: harness.tools,
    graphPack,
    fullFileTokens,
    agentLabel: harness.label,
  });
  const stages = report.tokens.stages;
  return {
    promptTokens: report.tokens.optimized,
    baselineTokens: report.tokens.baseline,
    userBefore: stages.nlp.before,
    userAfter: stages.toon.after,
    harnessBefore: stages.harness.before,
    harnessAfter: stages.harness.after,
    graphPack: stages.graph.pack,
    fullFiles: stages.graph.fullFiles,
  };
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
    const turn = measured ?? measureReducedTurn(String(input.prompt ?? ""), "", 0);
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

export function formatTokenNotice(turn: Partial<ReducedTurn> & { promptTokens: number }): string {
  if (
    turn.baselineTokens == null ||
    turn.userBefore == null ||
    turn.userAfter == null ||
    turn.harnessBefore == null ||
    turn.harnessAfter == null ||
    turn.graphPack == null ||
    turn.fullFiles == null
  ) {
    return `Input tokens: ${turn.promptTokens.toLocaleString("en-US")}`;
  }
  const graph =
    turn.fullFiles > 0
      ? `Graph ${turn.graphPack.toLocaleString("en-US")} instead of ${turn.fullFiles.toLocaleString("en-US")}`
      : "No file bodies added";
  return [
    `Reduced input: ${turn.promptTokens.toLocaleString("en-US")} tokens (was ${turn.baselineTokens.toLocaleString("en-US")})`,
    `Prompt ${turn.userBefore.toLocaleString("en-US")}→${turn.userAfter.toLocaleString("en-US")}`,
    `System and tools ${turn.harnessBefore.toLocaleString("en-US")}→${turn.harnessAfter.toLocaleString("en-US")}`,
    graph,
  ].join(". ") + ".";
}
