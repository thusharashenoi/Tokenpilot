import type { AgentId } from "./core/agents";
import type { GraphHit, GraphStats } from "./core/graph";
import type { AlignedTurn } from "./core/objective";
import type { OptimizeReport } from "./core/optimize";
import type { RouteDecision } from "./core/route";
import type { ChatMessage } from "./core/types";

export type OutputPreview = {
  messages: ChatMessage[];
  reasoning: AlignedTurn["reasoning"];
  maxTokens: number;
  actions: string[];
  goal: string;
};

export type WebviewToHost =
  | {
      type: "optimize";
      prompt: string;
      confidential: boolean;
      budgetUsd: number;
      primaryUp: boolean;
      agent?: AgentId;
      localModel?: string;
      smallModel?: string;
      strongModel?: string;
    }
  | { type: "send" }
  | { type: "reindex" }
  | { type: "lookup"; name: string }
  | { type: "sample" }
  | { type: "resetSpend" };

export type HostToWebview =
  | {
      type: "state";
      stats: GraphStats;
      userId: string;
      budgetUsd: number;
      spentUsd: number;
      confidential: boolean;
      models: { local: string; small: string; strong: string };
    }
  | { type: "report"; report: OptimizeReport; route: RouteDecision; hit: GraphHit; output: OutputPreview }
  | { type: "lookup"; hit: GraphHit }
  | { type: "prefill"; prompt: string }
  | {
      type: "sent";
      content: string;
      model: string;
      notice: string | null;
      spentUsd: number;
      remainingUsd: number;
      completionTokens: number | null;
      rewrittenTokens: number | null;
      reasoningTokens: number | null;
      outputActions: string[];
    }
  | { type: "error"; message: string };
