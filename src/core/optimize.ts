import { stripHarness, type ToolDef } from "./harness";
import { compactProse } from "./nlp";
import type { TaskKind } from "./route";
import { countTokens } from "./tokens";
import { encodeJsonBlocks } from "./toon";
import type { ChatMessage } from "./types";

export type { ChatMessage };

export type OptimizeInput = {
  systemPrompt: string;
  userText: string;
  tools: ToolDef[];
  graphPack: string;
  fullFileTokens: number;
  agentLabel?: string;
};

export type OptimizeReport = {
  systemPrompt: string;
  userText: string;
  tools: ToolDef[];
  messages: ChatMessage[];
  task: TaskKind;
  agentLabel?: string;
  actions: string[];
  droppedTools: string[];
  tokens: {
    baseline: number;
    optimized: number;
    saved: number;
    savedPct: number;
    stages: {
      nlp: { before: number; after: number };
      toon: { before: number; after: number };
      harness: { before: number; after: number };
      graph: { fullFiles: number; pack: number };
    };
  };
};

function countToolTokens(tools: ToolDef[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return countTokens(tools.map((tool) => `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters ?? {})}`).join("\n"));
}

export function optimizeInput(input: OptimizeInput): OptimizeReport {
  const nlpBefore = countTokens(input.userText);
  const compacted = compactProse(input.userText);
  const nlpAfter = countTokens(compacted);
  const tooned = encodeJsonBlocks(compacted);
  const toonAfter = countTokens(tooned.text);
  const harnessBefore = countTokens(input.systemPrompt) + countToolTokens(input.tools);
  const stripped = stripHarness(input.systemPrompt, input.tools, tooned.text);
  const pack = input.graphPack.trim();
  const packTokens = pack ? countTokens(pack) : 0;
  const systemPrompt = pack ? `${stripped.systemPrompt}\n\n${pack}` : stripped.systemPrompt;
  const harnessAfter = countTokens(stripped.systemPrompt) + countToolTokens(stripped.tools);
  const baseline = countTokens(input.systemPrompt) + nlpBefore + countToolTokens(input.tools) + input.fullFileTokens;
  const optimized = countTokens(systemPrompt) + toonAfter + countToolTokens(stripped.tools);
  const saved = baseline - optimized;
  const actions = [
    nlpBefore === nlpAfter
      ? "Task text kept. Nothing safe to remove."
      : `Task text ${nlpBefore} → ${nlpAfter} tokens.`,
    tooned.saved > 0
      ? `JSON encoded as TOON. ${nlpAfter} → ${toonAfter} tokens.`
      : "No JSON block was large enough to encode as TOON.",
    `${input.agentLabel ?? "Harness"} kept ${stripped.tools.length} of ${input.tools.length} tools.`,
  ];
  if (stripped.dropped.length > 0) {
    actions.push(`Dropped ${stripped.dropped.join(", ")}.`);
  }
  actions.push(
    input.fullFileTokens > 0
      ? `Graph pack is ${packTokens} tokens. The full files are ${input.fullFileTokens}.`
      : "No graph symbols matched this task. No file bodies were added.",
  );
  return {
    systemPrompt,
    userText: tooned.text,
    tools: stripped.tools,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: tooned.text },
    ],
    task: stripped.task,
    agentLabel: input.agentLabel,
    actions,
    droppedTools: stripped.dropped,
    tokens: {
      baseline,
      optimized,
      saved,
      savedPct: baseline === 0 ? 0 : Math.round((saved / baseline) * 100),
      stages: {
        nlp: { before: nlpBefore, after: nlpAfter },
        toon: { before: nlpAfter, after: toonAfter },
        harness: { before: harnessBefore, after: harnessAfter },
        graph: { fullFiles: input.fullFileTokens, pack: packTokens },
      },
    },
  };
}

export function formatTokenPopup(
  report: OptimizeReport,
  actual?: { promptTokens: number; model: string },
): { message: string; detail: string } {
  const tokens = report.tokens;
  const stages = tokens.stages;
  const lines = [
    `Before optimization: ${tokens.baseline}`,
    `After optimization: ${tokens.optimized}`,
    `Saved: ${tokens.saved} (${tokens.savedPct}%)`,
    "",
    `Task text: ${stages.nlp.before} → ${stages.nlp.after}`,
    `TOON: ${stages.toon.before} → ${stages.toon.after}`,
    `Harness and tools: ${stages.harness.before} → ${stages.harness.after}`,
    `Graph pack: ${stages.graph.pack}`,
    `Full files: ${stages.graph.fullFiles}`,
  ];
  if (actual) {
    lines.push("", `The provider counted ${actual.promptTokens} input tokens on ${actual.model}.`);
  }
  return {
    message: `Input tokens ${tokens.optimized}. Saved ${tokens.saved} (${tokens.savedPct}%).`,
    detail: lines.join("\n"),
  };
}
