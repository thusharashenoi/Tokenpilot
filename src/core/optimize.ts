import { stripHarness, type ToolDef } from "./harness";
import { distillHarness, type DistillOptions } from "./harnessDistill";
import type { TaskKind } from "./route";
import { countTokens } from "./tokens";
import type { ChatMessage } from "./types";
import { condenseUserPrompt } from "./userPrompt";

export type { ChatMessage };

export type OptimizeInput = {
  systemPrompt: string;
  userText: string;
  tools: ToolDef[];
  agentLabel?: string;
  rewrittenUserText?: string;
  distillHarness?: DistillOptions;
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
      harness: { before: number; after: number };
    };
  };
};

function countToolTokens(tools: ToolDef[]): number {
  if (tools.length === 0) {
    return 0;
  }
  return countTokens(tools.map((tool) => `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters ?? {})}`).join("\n"));
}

export async function optimizeInput(input: OptimizeInput): Promise<OptimizeReport> {
  const nlpBefore = countTokens(input.userText);
  const compacted = input.rewrittenUserText?.trim() ? input.rewrittenUserText : condenseUserPrompt(input.userText);
  const nlpAfter = countTokens(compacted);
  const harnessBefore = countTokens(input.systemPrompt) + countToolTokens(input.tools);
  
  // Choose harness stripping strategy
  let systemPrompt: string;
  let harnessAfter: number;
  
  if (input.distillHarness) {
    // LLM-based distillation
    try {
      const result = await distillHarness(input.systemPrompt, compacted, input.distillHarness);
      systemPrompt = result.distilled;
      
      // Still do tool filtering with JEV
      const stripped = stripHarness(input.systemPrompt, input.tools, compacted);
      harnessAfter = countTokens(systemPrompt) + countToolTokens(stripped.tools);
      
      const baseline = countTokens(input.systemPrompt) + nlpBefore + countToolTokens(input.tools);
      const optimized = countTokens(systemPrompt) + nlpAfter + countToolTokens(stripped.tools);
      const saved = baseline - optimized;
      
      const actions = [
        nlpBefore === nlpAfter
          ? "Task text kept. Nothing safe to remove."
          : `Task text ${nlpBefore} → ${nlpAfter} tokens.`,
        `Harness distilled: ${result.tokens.before} → ${result.tokens.after} tokens.`,
        `${input.agentLabel ?? "Harness"} kept ${stripped.tools.length} of ${input.tools.length} tools.`,
        `JEV attached ${stripped.tools.map((tool) => tool.name).join(", ") || "no tools"}.`,
      ];
      
      if (stripped.dropped.length > 0) {
        actions.push(`Dropped ${stripped.dropped.join(", ")}.`);
      }
      
      return {
        systemPrompt,
        userText: compacted,
        tools: stripped.tools,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: compacted },
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
            harness: { before: harnessBefore, after: harnessAfter },
          },
        },
      };
    } catch (error) {
      // Fall through to rule-based stripping
    }
  }
  
  // Rule-based stripping (fallback or default)
  const stripped = stripHarness(input.systemPrompt, input.tools, compacted);
  systemPrompt = stripped.systemPrompt;
  harnessAfter = countTokens(systemPrompt) + countToolTokens(stripped.tools);
  
  const baseline = countTokens(input.systemPrompt) + nlpBefore + countToolTokens(input.tools);
  const optimized = countTokens(systemPrompt) + nlpAfter + countToolTokens(stripped.tools);
  const saved = baseline - optimized;
  
  const actions = [
    nlpBefore === nlpAfter
      ? "Task text kept. Nothing safe to remove."
      : `Task text ${nlpBefore} → ${nlpAfter} tokens.`,
    `${input.agentLabel ?? "Harness"} kept ${stripped.tools.length} of ${input.tools.length} tools.`,
    `JEV attached ${stripped.tools.map((tool) => tool.name).join(", ") || "no tools"}.`,
  ];
  
  if (stripped.dropped.length > 0) {
    actions.push(`Dropped ${stripped.dropped.join(", ")}.`);
  }
  
  return {
    systemPrompt,
    userText: compacted,
    tools: stripped.tools,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: compacted },
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
        harness: { before: harnessBefore, after: harnessAfter },
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
    `Harness and tools: ${stages.harness.before} → ${stages.harness.after}`,
  ];
  if (actual) {
    lines.push("", `The provider counted ${actual.promptTokens} input tokens on ${actual.model}.`);
  }
  return {
    message: `Input tokens ${tokens.optimized}. Saved ${tokens.saved} (${tokens.savedPct}%).`,
    detail: lines.join("\n"),
  };
}
