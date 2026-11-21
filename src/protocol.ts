import type { AgentId } from "./core/agents";
import type { OptimizeReport } from "./core/optimize";
import type { RouteDecision } from "./core/route";

export type WebviewToHost =
  | { type: "optimize"; prompt: string; confidential: boolean; budgetUsd: number; primaryUp: boolean; agent?: AgentId }
  | { type: "sample" }
  | { type: "resetSpend" };

export type HostToWebview =
  | {
      type: "state";
      userId: string;
      budgetUsd: number;
      spentUsd: number;
      confidential: boolean;
      models: { local: string; small: string; strong: string };
    }
  | { type: "report"; report: OptimizeReport; route: RouteDecision }
  | { type: "prefill"; prompt: string }
  | { type: "sent"; content: string; model: string; notice: string | null; spentUsd: number; remainingUsd: number }
  | { type: "error"; message: string };
