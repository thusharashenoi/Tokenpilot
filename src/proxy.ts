import http from "http";
import { sendViaBifrost, type BifrostResult } from "./core/bifrost";
import { answerReady, followUpForPlan, replyText, toolCallsFrom } from "./core/finishReply";
import { prepareTurn } from "./core/prepareTurn";
import { holdExistingSignatures, rewriteReply } from "./core/rewrite";
import { estimateCost, type ModelIds, type ModelTier } from "./core/route";
import { countTokens } from "./core/tokens";

export type ProxySettings = {
  bifrostUrl: string;
  bifrostPath: string;
  localUrl: string;
  models: ModelIds;
  confidential: boolean;
  budgetRemainingUsd: number;
  providerUp: boolean;
};

export type ProxyRun = {
  id: string;
  at: string;
  arm: "bare" | "tokenpilot";
  model: string;
  promptBefore: number;
  promptAfter: number;
  completionTokens: number | null;
  storedTokens: number | null;
  reasoningTokens: number | null;
  notice: string | null;
  reply: string;
  error: string | null;
  latencyMs: number;
};

export type ProxyHandle = {
  port: number;
  close: () => Promise<void>;
  runs: () => ProxyRun[];
};

const runs: ProxyRun[] = [];

export function listRuns(): ProxyRun[] {
  return runs.slice();
}

export function clearRuns(): void {
  runs.length = 0;
}

function remember(run: ProxyRun): void {
  runs.unshift(run);
  runs.splice(40);
}

function tierOf(model: string, models: ModelIds): ModelTier {
  if (model === models.local) {
    return "local";
  }
  if (model === models.small) {
    return "small";
  }
  return "strong";
}

function noticeBody(notice: string): Record<string, unknown> {
  return {
    id: "tokenpilot-notice",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: notice } }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };
}

function headerMap(prepared: { promptBefore: number; promptAfter: number }, completion: number | null, stored: number | null, notice: string | null): Record<string, string> {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "x-tokenpilot-prompt-before": String(prepared.promptBefore),
    "x-tokenpilot-prompt-after": String(prepared.promptAfter),
    "x-tokenpilot-completion": completion == null ? "" : String(completion),
    "x-tokenpilot-stored": stored == null ? "" : String(stored),
    "x-tokenpilot-reasoning": "",
    "x-tokenpilot-notice": notice ?? "",
  };
}

export async function completeThroughProxy(input: {
  settings: ProxySettings;
  workspaceRoot: string;
  tavilyKey: string;
  body: Record<string, unknown>;
  optimize: boolean;
  lockModel: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown>; run: ProxyRun }> {
  const started = Date.now();
  const prepared = await prepareTurn({
    body: input.body,
    workspaceRoot: input.workspaceRoot,
    models: input.settings.models,
    confidential: input.settings.confidential,
    budgetRemainingUsd: input.settings.budgetRemainingUsd,
    providerUp: input.settings.providerUp,
    tavilyKey: input.tavilyKey,
    optimize: input.optimize,
    lockModel: input.lockModel,
    fetchImpl: input.fetchImpl,
  });
  const arm = input.optimize ? "tokenpilot" : "bare";
  if (prepared.blocked || !prepared.model || prepared.via === "none") {
    const notice = prepared.notice ?? "This turn was not sent.";
    const run: ProxyRun = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      arm,
      model: prepared.model ?? "none",
      promptBefore: prepared.promptBefore,
      promptAfter: prepared.promptAfter,
      completionTokens: 0,
      storedTokens: countTokens(notice),
      reasoningTokens: null,
      notice,
      reply: notice,
      error: null,
      latencyMs: Date.now() - started,
    };
    remember(run);
    return { status: 200, headers: headerMap(prepared, 0, run.storedTokens, notice), body: noticeBody(notice), run };
  }
  try {
    const messages: Array<Record<string, unknown>> = prepared.messages.map((message) => ({ ...message }));
    let tools = Array.isArray(prepared.tools) ? prepared.tools : undefined;
    const callModel = (): Promise<BifrostResult> =>
      sendViaBifrost({
        via: prepared.via === "local" ? "local" : "bifrost",
        baseUrl: input.settings.bifrostUrl,
        path: input.settings.bifrostPath,
        model: prepared.model ?? "",
        fallbacks: prepared.fallbacks,
        messages: messages as never,
        tools,
        localBaseUrl: input.settings.localUrl,
        localModel: input.settings.models.local,
        maxTokens: prepared.maxTokens,
        reasoningEffort: prepared.reasoningEffort,
        logLabels: { arm: input.optimize ? "tokenpilot" : "bare", source: "tokenpilot" },
        fetchImpl: input.fetchImpl,
      });
    let result = await callModel();
    const billedPrompt = result.usage?.promptTokens ?? prepared.promptAfter;
    const openedWith = messages.slice();
    let completion = result.usage?.completionTokens ?? 0;
    let reasoning = result.usage?.reasoningTokens ?? 0;
    for (let step = 0; step < 2; step += 1) {
      const rawTurn = result.message ?? { role: "assistant", content: result.content };
      const calls = toolCallsFrom(rawTurn);
      const text = replyText(rawTurn, result.content);
      if (answerReady(text, calls)) {
        break;
      }
      messages.splice(0, messages.length, ...openedWith.map((message) => ({ ...message })));
      tools = undefined;
      messages.push({ role: "user", content: followUpForPlan(input.workspaceRoot, text) });
      const continued = await callModel();
      completion += continued.usage?.completionTokens ?? 0;
      reasoning += continued.usage?.reasoningTokens ?? 0;
      const continuedText = replyText(continued.message ?? { role: "assistant", content: continued.content }, continued.content);
      if (!continuedText.trim() && text.trim()) {
        break;
      }
      result = continued;
    }
    if (result.usage) {
      result = {
        ...result,
        usage: { ...result.usage, promptTokens: billedPrompt, completionTokens: completion, reasoningTokens: reasoning },
      };
    }
    const raw = result.message ?? { role: "assistant", content: result.content };
    const hasTools = Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0;
    let content = replyText(raw, result.content);
    if (!content.trim()) {
      content = "The model returned no message text. Those completion tokens were spent on a tool call.";
    }
    let stored = countTokens(content);
    if (input.optimize && !hasTools) {
      const rewritten = rewriteReply(content, prepared.goal, prepared.urls.length > 0 ? prepared.urls : undefined);
      content = holdExistingSignatures(rewritten.text, prepared.scope);
      stored = countTokens(content);
    }
    const completionTokens = result.usage ? completion : countTokens(result.content);
    const run: ProxyRun = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      arm,
      model: result.modelUsed,
      promptBefore: prepared.promptBefore,
      promptAfter: result.usage?.promptTokens ?? prepared.promptAfter,
      completionTokens,
      storedTokens: stored,
      reasoningTokens: result.usage?.reasoningTokens ?? null,
      notice: result.notifyUser,
      reply: content.slice(0, 4000),
      error: null,
      latencyMs: Date.now() - started,
    };
    remember(run);
    return {
      status: 200,
      headers: {
        ...headerMap(prepared, completionTokens, stored, result.notifyUser),
        "x-tokenpilot-reasoning": result.usage?.reasoningTokens == null ? "" : String(result.usage.reasoningTokens),
      },
      body: {
        id: "tokenpilot",
        object: "chat.completion",
        model: result.modelUsed,
        choices: [{ index: 0, finish_reason: hasTools ? "tool_calls" : "stop", message: { ...raw, role: "assistant", content } }],
        usage: {
          prompt_tokens: run.promptAfter,
          completion_tokens: completion,
          completion_tokens_details: { reasoning_tokens: result.usage?.reasoningTokens ?? 0 },
        },
      },
      run,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The model call failed.";
    const run: ProxyRun = {
      id: `${Date.now()}`,
      at: new Date().toISOString(),
      arm,
      model: prepared.model,
      promptBefore: prepared.promptBefore,
      promptAfter: prepared.promptAfter,
      completionTokens: null,
      storedTokens: null,
      reasoningTokens: null,
      notice: null,
      reply: "",
      error: message,
      latencyMs: Date.now() - started,
    };
    remember(run);
    return {
      status: 502,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: { error: { message } },
      run,
    };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startProxy(options: {
  port: number;
  settings: () => ProxySettings;
  workspaceRoot: () => string;
  tavilyKey: () => Promise<string>;
  onSpend: (usd: number) => Promise<void>;
}): Promise<ProxyHandle> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/runs") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ runs: listRuns() }));
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found" } }));
      return;
    }
    const optimize = (req.headers["x-tokenpilot-optimize"] ?? "on") !== "off";
    const lockModel = req.headers["x-tokenpilot-lock-model"] === "on";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The body is not JSON." } }));
      return;
    }
    if (body.stream === true) {
      res.writeHead(400, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: { message: "Turn streaming off for this base URL. TokenPilot compares full replies. Set stream to false." } }));
      return;
    }
    const settings = options.settings();
    const result = await completeThroughProxy({
      settings,
      workspaceRoot: options.workspaceRoot(),
      tavilyKey: await options.tavilyKey(),
      body,
      optimize,
      lockModel,
    });
    if (result.status === 200 && result.run.completionTokens != null && result.run.error == null && result.run.notice?.startsWith("Budget") !== true) {
      const model = result.run.model;
      const cost = estimateCost(tierOf(model, settings.models), result.run.promptAfter, result.run.completionTokens);
      if (cost > 0) {
        await options.onSpend(cost);
      }
    }
    res.writeHead(result.status, result.headers);
    res.end(JSON.stringify(result.body));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      resolve({
        port: options.port,
        runs: listRuns,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}
