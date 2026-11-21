import http from "http";
import type { ReduceReport } from "./core/reduce";
import { isReducible, lastUserText, prepareUpstreamBody, readUsage, spendFrom, takeUsageLines, type ProxySpend, type TokenUsage } from "./core/proxy";

const BODY_LIMIT = 32 * 1024 * 1024;
const REQUEST_HEADERS = ["authorization", "content-type", "accept", "x-api-key", "x-bf-vk", "x-bf-api-key", "anthropic-version", "openai-beta", "openai-organization"];
const DROP_RESPONSE = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

export type IdeTurnInput = { prompt: string; conversationId: string };

export type IdeTurnOutput = { content: string; model: string; notice: string | null };

export type ProxyOptions = {
  port: number;
  upstream: string;
  key?: string;
  rewriteUser?: (text: string) => Promise<string>;
  pickModel?: (userText: string) => Promise<{ model: string; fallbacks: string[] } | null>;
  onSpend?: (spend: ProxySpend) => void;
  ideToken?: string;
  onIdeTurn?: (input: IdeTurnInput, signal: AbortSignal) => Promise<IdeTurnOutput>;
};

export type RunningProxy = {
  port: number;
  close: () => Promise<void>;
};

export function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const server = http.createServer((req, res) => {
    void handle(req, res, options).catch((error: unknown) => {
      if (res.headersSent || res.writableEnded) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : "TokenPilot proxy failed.";
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message, type: "proxy_error" } }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, options: ProxyOptions): Promise<void> {
  const incoming = await readBody(req);
  if (requestPath(req.url) === "/tokenpilot/turn") {
    await handleIdeTurn(req, res, incoming, options);
    return;
  }
  let body = incoming;
  let spendBase: ReduceReport | null = null;
  if (req.method === "POST" && isJson(req) && incoming.length > 0) {
    const parsed = parseObject(incoming);
    if (parsed && isReducible(parsed)) {
      spendBase = await prepareUpstreamBody(parsed, options.rewriteUser);
      if (options.pickModel) {
        try {
          const choice = await options.pickModel(lastUserText(spendBase.payload));
          if (choice?.model) {
            spendBase.payload.model = choice.model;
            if (choice.fallbacks.length > 0) {
              spendBase.payload.fallbacks = choice.fallbacks;
            }
          }
        } catch {
          // Keep the model already on the request.
        }
      }
      body = Buffer.from(JSON.stringify(spendBase.payload));
    }
  }
  const upstream = await fetch(upstreamUrl(options.upstream, req.url), {
    method: req.method,
    headers: forwardHeaders(req, options.key, body.length > 0),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
  const headers = responseHeaders(upstream);
  if (!upstream.body) {
    const text = await upstream.text();
    notify(options, spendBase, upstream.status, text);
    res.writeHead(upstream.status, headers);
    res.end(text);
    return;
  }
  res.writeHead(upstream.status, headers);
  const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  const forwarded = await pipe(upstream.body, res, streamed);
  if (spendBase && upstream.ok) {
    options.onSpend?.(spendFrom(spendBase, forwarded, Date.now()));
  }
  res.end();
}

async function pipe(body: ReadableStream<Uint8Array>, res: http.ServerResponse, streamed: boolean): Promise<TokenUsage | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let usage: TokenUsage | null = null;
  const chunks: Buffer[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    const bytes = Buffer.from(chunk.value);
    res.write(bytes);
    if (streamed) {
      pending += decoder.decode(chunk.value, { stream: true });
      const scanned = takeUsageLines(pending);
      pending = scanned.rest;
      if (scanned.usage) {
        usage = scanned.usage;
      }
    } else {
      chunks.push(bytes);
    }
  }
  if (streamed) {
    pending += decoder.decode();
    const tail = takeUsageLines(`${pending}\n`);
    if (tail.usage) {
      usage = tail.usage;
    }
    return usage;
  }
  try {
    return readUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return null;
  }
}

function notify(options: ProxyOptions, report: ReduceReport | null, status: number, text: string): void {
  if (!report || status < 200 || status >= 300) {
    return;
  }
  let usage: TokenUsage | null = null;
  try {
    usage = readUsage(JSON.parse(text));
  } catch {
    usage = null;
  }
  options.onSpend?.(spendFrom(report, usage, Date.now()));
}

async function handleIdeTurn(req: http.IncomingMessage, res: http.ServerResponse, incoming: Buffer, options: ProxyOptions): Promise<void> {
  const header = req.headers.authorization;
  const presented = typeof header === "string" ? header : "";
  if (req.method !== "POST" || !options.ideToken || !options.onIdeTurn || presented !== `Bearer ${options.ideToken}`) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }
  const parsed = parseObject(incoming);
  const prompt = parsed && typeof parsed.prompt === "string" ? parsed.prompt : "";
  const conversationId = parsed && typeof parsed.conversationId === "string" ? parsed.conversationId : "";
  const controller = new AbortController();
  const stop = (): void => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  req.on("close", stop);
  try {
    const output = await options.onIdeTurn({ prompt, conversationId }, controller.signal);
    if (controller.signal.aborted || res.writableEnded) {
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, content: output.content, model: output.model, notice: output.notice }));
  } catch {
    if (res.headersSent || res.writableEnded) {
      res.end();
      return;
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  } finally {
    req.off("close", stop);
  }
}

function requestPath(url: string | undefined): string {
  const raw = url && url.length > 0 ? url : "/";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

function upstreamUrl(origin: string, target: string | undefined): string {
  const base = origin.replace(/\/$/, "");
  const path = target && target.startsWith("/") ? target : `/${target ?? ""}`;
  return base + path;
}

function forwardHeaders(req: http.IncomingMessage, key: string | undefined, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string" && value) {
      headers[name] = value;
    }
  }
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  if (hasBody && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return headers;
}

function responseHeaders(upstream: Response): Record<string, string | number> {
  const headers: Record<string, string | number> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) {
      headers[name] = value;
    }
  });
  return headers;
}

function isJson(req: http.IncomingMessage): boolean {
  const type = req.headers["content-type"];
  return typeof type === "string" && type.includes("application/json");
}

function parseObject(body: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
