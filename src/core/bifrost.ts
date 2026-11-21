import type { ChatMessage } from "./types";

export type BifrostRequest = {
  via: "local" | "bifrost";
  baseUrl: string;
  path: string;
  model: string;
  fallbacks: string[];
  messages: ChatMessage[];
  tools?: unknown[];
  localBaseUrl?: string;
  localModel?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

export type BifrostResult = {
  content: string;
  modelUsed: string;
  provider: string | null;
  usedFallback: boolean;
  notifyUser: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
};

const FAILOVER = new Set([408, 409, 429, 500, 502, 503, 504]);

function endpoint(origin: string, path: string): string {
  const base = origin.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return base + suffix;
}

function contentOf(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

type Attempt = { origin: string; path: string; model: string; cloud: boolean };

export async function sendViaBifrost(input: BifrostRequest): Promise<BifrostResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const attempts: Attempt[] = [];
  if (input.via === "local") {
    if (!input.localBaseUrl || !input.localModel) {
      throw new Error("A confidential repository needs a local model URL.");
    }
    attempts.push({
      origin: input.localBaseUrl,
      path: "/v1/chat/completions",
      model: input.localModel,
      cloud: false,
    });
  } else {
    const seen = new Set<string>();
    for (const model of [input.model, ...input.fallbacks]) {
      if (!model || seen.has(model)) {
        continue;
      }
      seen.add(model);
      attempts.push({ origin: input.baseUrl, path: input.path, model, cloud: true });
    }
  }

  let lastError = "The model call failed.";
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    try {
      const response = await post(fetchImpl, input, attempt);
      if (!response.ok) {
        const detail = await response.text();
        lastError = `Model ${attempt.model} returned ${response.status}. ${detail}`.trim();
        if (FAILOVER.has(response.status)) {
          continue;
        }
        throw new Error(lastError);
      }
      return await readSuccess(response, attempt.model, index > 0);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Model ")) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : lastError;
    }
  }

  if (input.via === "bifrost" && input.localBaseUrl && input.localModel) {
    const local: Attempt = {
      origin: input.localBaseUrl,
      path: "/v1/chat/completions",
      model: input.localModel,
      cloud: false,
    };
    const response = await post(fetchImpl, input, local);
    if (!response.ok) {
      throw new Error(lastError);
    }
    const result = await readSuccess(response, local.model, true);
    result.notifyUser = `Bifrost is unreachable. This turn moved to ${local.model}. The session stays open.`;
    return result;
  }
  throw new Error(lastError);
}

async function post(fetchImpl: typeof fetch, input: BifrostRequest, attempt: Attempt): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const body: Record<string, unknown> = {
    model: attempt.model,
    messages: input.messages,
    max_tokens: input.maxTokens ?? 800,
  };
  if (attempt.cloud && input.fallbacks.length > 0) {
    body.fallbacks = input.fallbacks.filter((model) => model !== attempt.model);
  }
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
  }
  return fetchImpl(endpoint(attempt.origin, attempt.path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readSuccess(response: Response, requested: string, laterAttempt: boolean): Promise<BifrostResult> {
  const body = (await response.json()) as {
    choices?: Array<{ message?: unknown }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    extra_fields?: { routing_info?: { is_fallback?: boolean; model?: string; provider?: string } };
  };
  const info = body.extra_fields?.routing_info;
  const headerFallback = response.headers.get("x-bifrost-routing-info-is-fallback") === "true";
  const usedFallback = headerFallback || info?.is_fallback === true || laterAttempt;
  const modelUsed =
    response.headers.get("x-bifrost-routing-info-model") || info?.model || requested;
  const provider = response.headers.get("x-bifrost-routing-info-provider") || info?.provider || null;
  const usage = body.usage
    ? {
        promptTokens: body.usage.prompt_tokens ?? 0,
        completionTokens: body.usage.completion_tokens ?? 0,
      }
    : null;
  return {
    content: contentOf(body.choices?.[0]?.message),
    modelUsed,
    provider,
    usedFallback,
    notifyUser: usedFallback
      ? `${requested} did not answer. ${modelUsed} took this turn. The session stays open.`
      : null,
    usage,
  };
}
