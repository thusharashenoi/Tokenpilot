import { reduceProviderPayload, type ReduceReport } from "./reduce";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type ProxySpend = {
  id: string;
  model: string;
  beforeTokens: number;
  afterTokens: number;
  keptTools: string[];
  droppedTools: string[];
  usage: TokenUsage | null;
};

export function lastUserText(body: Record<string, unknown>): string {
  if (Array.isArray(body.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index -= 1) {
      const message = body.messages[index] as { role?: unknown; content?: unknown } | null;
      if (message && message.role === "user") {
        return textOf(message.content);
      }
    }
  }
  if (typeof body.input === "string") {
    return body.input;
  }
  if (Array.isArray(body.input)) {
    for (let index = body.input.length - 1; index >= 0; index -= 1) {
      const item = body.input[index] as { role?: unknown; content?: unknown; text?: unknown } | null;
      if (item && item.role === "user") {
        return textOf(item.content ?? item.text);
      }
    }
  }
  return "";
}

export function isReducible(body: Record<string, unknown>): boolean {
  return Array.isArray(body.messages) || typeof body.instructions === "string" || typeof body.input === "string" || Array.isArray(body.input);
}

export async function prepareUpstreamBody(
  body: Record<string, unknown>,
  rewrite?: (text: string) => Promise<string>,
): Promise<ReduceReport> {
  let userText: string | undefined;
  if (rewrite) {
    const raw = lastUserText(body);
    if (raw.trim()) {
      try {
        userText = await rewrite(raw);
      } catch {
        userText = undefined;
      }
    }
  }
  const report = reduceProviderPayload(body, userText);
  if (report.payload.stream === true && Array.isArray(body.messages)) {
    const current = report.payload.stream_options;
    const options = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    options.include_usage = true;
    report.payload.stream_options = options;
  }
  return report;
}

export function readUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { usage?: unknown; response?: { usage?: unknown } };
  const usage = record.usage ?? record.response?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const counts = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown };
  const prompt = numberOf(counts.prompt_tokens ?? counts.input_tokens);
  const completion = numberOf(counts.completion_tokens ?? counts.output_tokens);
  if (prompt == null && completion == null) {
    return null;
  }
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 };
}

export function takeUsageLines(buffer: string): { rest: string; usage: TokenUsage | null } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  let usage: TokenUsage | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const found = readUsage(JSON.parse(data));
      if (found) {
        usage = found;
      }
    } catch {
      continue;
    }
  }
  return { rest, usage };
}

export function spendFrom(report: ReduceReport, usage: TokenUsage | null, now: number): ProxySpend {
  return {
    id: `proxy:${now}`,
    model: typeof report.payload.model === "string" ? report.payload.model : "",
    beforeTokens: report.beforeTokens,
    afterTokens: report.afterTokens,
    keptTools: report.keptTools,
    droppedTools: report.droppedTools,
    usage,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
