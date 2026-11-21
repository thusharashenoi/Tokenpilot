export type TaskKind = "lookup" | "edit" | "reason";
export type ModelTier = "local" | "small" | "strong";

export type ModelIds = {
  local: string;
  small: string;
  strong: string;
};

export type RouteInput = {
  confidential: boolean;
  taskKind: TaskKind;
  promptTokens: number;
  budgetRemainingUsd: number;
  providerUp: boolean;
  models: ModelIds;
};

export type RouteDecision = {
  blocked: boolean;
  via: "local" | "bifrost" | "none";
  model: string | null;
  fallbacks: string[];
  tier: ModelTier;
  reason: string;
  notifyUser: string | null;
  estimatedCostUsd: number;
};

export type RoutingPolicy = (input: RouteInput) => RouteDecision;

export const MAX_OUTPUT_TOKENS = 800;

const PRICE_PER_MILLION: Record<ModelTier, { in: number; out: number }> = {
  local: { in: 0, out: 0 },
  small: { in: 0.15, out: 0.6 },
  strong: { in: 2.5, out: 10 },
};

export function classifyTask(text: string): TaskKind {
  if (/\b(implement|fix|edit|update|change|add|refactor|write|rename|delete|remove)\b/i.test(text)) {
    return "edit";
  }
  if (/\b(design|architect|trade-?off)\b/i.test(text)) {
    return "reason";
  }
  return "lookup";
}

export function estimateCost(tier: ModelTier, promptTokens: number, completionTokens: number): number {
  const price = PRICE_PER_MILLION[tier];
  return (promptTokens * price.in + completionTokens * price.out) / 1_000_000;
}

function localDecision(input: RouteInput, reason: string, notifyUser: string | null): RouteDecision {
  return {
    blocked: false,
    via: "local",
    model: input.models.local,
    fallbacks: [],
    tier: "local",
    reason,
    notifyUser,
    estimatedCostUsd: 0,
  };
}

/**
 * Fallback when the Bifrost model list cannot be read.
 * The catalog overlay replaces this choice when a listed model matches the task.
 * Confidential turns stay on the local model. The prompt text cannot name the provider.
 */
export function defaultPolicy(input: RouteInput): RouteDecision {
  if (input.confidential) {
    return localDecision(
      input,
      "Confidential repository.",
      "This repository is confidential, so the local model will answer.",
    );
  }
  const primaryTier: ModelTier = input.taskKind === "lookup" ? "small" : "strong";
  const primary = primaryTier === "small" ? input.models.small : input.models.strong;
  const secondary = primaryTier === "small" ? input.models.strong : input.models.small;
  const secondaryTier: ModelTier = primaryTier === "small" ? "strong" : "small";
  const chosenTier = input.providerUp ? primaryTier : secondaryTier;
  const estimatedCostUsd = estimateCost(chosenTier, input.promptTokens, MAX_OUTPUT_TOKENS);
  if (estimatedCostUsd > input.budgetRemainingUsd + 1e-12) {
    const cost = estimatedCostUsd.toFixed(4);
    const left = Math.max(0, input.budgetRemainingUsd).toFixed(4);
    return {
      blocked: true,
      via: "none",
      model: null,
      fallbacks: [],
      tier: chosenTier,
      reason: "Budget reached.",
      notifyUser: `Budget reached. This turn would cost about $${cost} and $${left} is left. No model was called.`,
      estimatedCostUsd,
    };
  }
  if (!input.providerUp) {
    return {
      blocked: false,
      via: "bifrost",
      model: secondary,
      fallbacks: [],
      tier: secondaryTier,
      reason: `${primary} is unavailable.`,
      notifyUser: `${primary} is unavailable. This turn uses ${secondary}. The session stays open.`,
      estimatedCostUsd,
    };
  }
  return {
    blocked: false,
    via: "bifrost",
    model: primary,
    fallbacks: [secondary],
    tier: primaryTier,
    reason: input.taskKind === "lookup" ? "Lookup on the small model." : "Edit or design on the strong model.",
    notifyUser: null,
    estimatedCostUsd,
  };
}

export function routeTurn(input: RouteInput, policy: RoutingPolicy = defaultPolicy): RouteDecision {
  const decision = policy(input);
  if (!input.confidential) {
    return decision;
  }
  if (decision.via === "local" && !decision.blocked && decision.model === input.models.local) {
    return decision;
  }
  return localDecision(
    input,
    "Confidential repository. Forced the local model.",
    "This repository is confidential, so the local model will answer.",
  );
}
