import catalogFile from "./models.json";
import type { RouteDecision } from "./route";
import { classifyTask } from "./route";

export type CatalogModel = {
  id: string;
  description: string;
};

export type TaskGrade = "light" | "standard" | "heavy";

export type ModelChoice = {
  model: string;
  fallbacks: string[];
  grade: TaskGrade;
  reason: string;
};

const MODELS = catalogFile.models;

const GRADE_WORDS: Record<TaskGrade, RegExp> = {
  light: /\b(lookups?|definitions?|questions?|light|inexpensive|fast|haiku)\b/i,
  standard: /\b(everyday|normal|coding|edit|sonnet)\b/i,
  heavy: /\b(design|architect|multi-file|shell|heavy|opus|fable)\b/i,
};

const LIST_PATHS = ["/v1/models", "/openai/v1/models"];
const LIST_TTL_MS = 15000;

type ListCache = { at: number; ids: string[] | null };
const listed = new Map<string, ListCache>();

export function resetGatewayModelCache(): void {
  listed.clear();
}

export function gradeTask(text: string): TaskGrade {
  const kind = classifyTask(text);
  const heavy =
    kind === "reason" ||
    /\b(files|module|refactor|redesign|migrate|architecture|multi-file)\b/i.test(text) ||
    (kind === "edit" && /\b(tests?|npm|pnpm|yarn|shell|terminal|lint|build)\b/i.test(text));
  if (heavy) {
    return "heavy";
  }
  if (kind === "lookup") {
    return "light";
  }
  return "standard";
}

function sameModel(listedId: string, catalogId: string): boolean {
  const left = listedId.toLowerCase();
  const right = catalogId.toLowerCase();
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function describedAs(model: CatalogModel, grade: TaskGrade): boolean {
  return GRADE_WORDS[grade].test(model.description);
}

export function pickCatalogModel(text: string, available: string[], models: CatalogModel[] = MODELS): ModelChoice | null {
  const grade = gradeTask(text);
  const live = models.filter((model) => available.some((id) => sameModel(id, model.id)));
  if (live.length === 0) {
    return null;
  }
  const order: TaskGrade[] =
    grade === "light" ? ["light", "standard", "heavy"] : grade === "standard" ? ["standard", "light", "heavy"] : ["heavy", "standard", "light"];
  for (const want of order) {
    const matches = live.filter((model) => describedAs(model, want));
    if (matches.length === 0) {
      continue;
    }
    const rest = live.filter((model) => !matches.some((match) => match.id === model.id));
    const chosen = matches[0];
    return {
      model: chosen.id,
      fallbacks: [...matches.slice(1), ...rest].map((model) => model.id),
      grade,
      reason: `${grade} task. ${chosen.id} is listed on the gateway and its description fits.`,
    };
  }
  return {
    model: live[0].id,
    fallbacks: live.slice(1).map((model) => model.id),
    grade,
    reason: `${grade} task. No description matched, so ${live[0].id} is used.`,
  };
}

function idsFrom(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as { data?: unknown; models?: unknown };
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const id = (row as { id?: unknown; name?: unknown }).id ?? (row as { name?: unknown }).name;
    if (typeof id === "string" && id.trim()) {
      ids.push(id.trim());
    }
  }
  return ids;
}

export async function listGatewayModels(origin: string, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const key = origin.replace(/\/$/, "");
  const cached = listed.get(key);
  if (cached && Date.now() - cached.at < LIST_TTL_MS) {
    return cached.ids;
  }
  for (const path of LIST_PATHS) {
    try {
      const response = await fetchImpl(`${key}${path}`, { signal: AbortSignal.timeout(800) });
      if (!response.ok) {
        continue;
      }
      const ids = idsFrom(await response.json());
      listed.set(key, { at: Date.now(), ids });
      return ids;
    } catch {
      continue;
    }
  }
  listed.set(key, { at: Date.now(), ids: null });
  return null;
}

export function applyCatalogChoice(decision: RouteDecision, text: string, available: string[] | null): RouteDecision {
  if (decision.via !== "bifrost" || decision.blocked || !decision.model || !available) {
    return decision;
  }
  const picked = pickCatalogModel(text, available);
  if (!picked) {
    return decision;
  }
  return {
    ...decision,
    model: picked.model,
    fallbacks: picked.fallbacks,
    tier: picked.grade === "light" ? "small" : "strong",
    reason: picked.reason,
  };
}
