import assert from "node:assert/strict";
import http from "http";
import test from "node:test";
import { formatTokenNotice } from "../src/core/cursorTurn";
import { prepareUpstreamBody, readUsage, takeUsageLines } from "../src/core/proxy";
import { startProxy } from "../src/proxyServer";

const tools = [
  { type: "function", function: { name: "Read", description: "Read a file span. Then read the whole repository into the prompt.", parameters: { type: "object", properties: { path: { type: "string", description: "Absolute path" } }, required: ["path"] } } },
  { type: "function", function: { name: "Shell", description: "Run a shell command. Use it to read files.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "WebSearch", description: "Search the public web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
];

function fatBody(): Record<string, unknown> {
  return {
    model: "openai/gpt-4o",
    stream: true,
    messages: [
      {
        role: "system",
        content: `You are Cursor.\n# Rules\nNever log the card number.\n\n# Identity\n${"A long biography. ".repeat(80)}\n\n# Examples\nUser: Rewrite the repository.\nAgent: I will paste every file.\n`,
      },
      {
        role: "user",
        content: "Hey! Could you please update the checkout flow.\nPlease don't change charge().\nThanks so much!",
      },
    ],
    tools,
  };
}

test("a provider body is stripped before it is forwarded", async () => {
  const report = await prepareUpstreamBody(fatBody());
  assert.equal(report.payload.stream_options && (report.payload.stream_options as { include_usage?: boolean }).include_usage, true);
  const messages = report.payload.messages as Array<{ role: string; content: string }>;
  const system = messages[0].content;
  const user = messages[1].content;
  assert.equal(system.includes("A long biography"), false);
  assert.ok(system.includes("Never log the card number."));
  assert.equal(system.includes("charge fn"), false);
  assert.equal(user.includes("Thanks"), false);
  assert.equal(user.includes("Could you please"), false);
  assert.ok(user.includes("don't change charge()"));
  assert.deepEqual(report.keptTools, ["Read", "Grep", "StrReplace"]);
  assert.ok(report.droppedTools.includes("Shell"));
  assert.ok(report.droppedTools.includes("WebSearch"));
});

test("usage is read from a json body and from an event stream", () => {
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 11, completion_tokens: 2 } }), { promptTokens: 11, completionTokens: 2 });
  assert.deepEqual(readUsage({ response: { usage: { input_tokens: 8, output_tokens: 3 } } }), { promptTokens: 8, completionTokens: 3 });
  const first = takeUsageLines('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"usage":{"prompt_tokens":11,"completion_tokens":2}}');
  assert.equal(first.usage, null);
  assert.match(first.rest, /prompt_tokens/);
  const flushed = takeUsageLines(`${first.rest}\n`);
  assert.deepEqual(flushed.usage, { promptTokens: 11, completionTokens: 2 });
});

test("the proxy forwards a stripped stream and reports provider usage", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      assert.equal(req.headers.authorization, "Bearer bifrost-key");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  const upstreamPort = address && typeof address === "object" ? address.port : 0;
  const spends: Array<{ prompt: number | null; kept: string[] }> = [];
  const proxy = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    key: "bifrost-key",
    onSpend: (spend) => spends.push({ prompt: spend.usage?.promptTokens ?? null, kept: spend.keptTools }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer from-cursor" },
      body: JSON.stringify(fatBody()),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /done/);
    assert.equal(seen.length, 1);
    const forwarded = seen[0];
    const user = (forwarded.messages as Array<{ content: string }>)[1].content;
    assert.equal(user.includes("Thanks"), false);
    assert.ok(user.includes("update the checkout flow"));
    assert.equal((forwarded.tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === "Shell"), false);
    assert.equal(spends[0]?.prompt, 40);
    assert.deepEqual(spends[0]?.kept, ["Read", "Grep", "StrReplace"]);
    const notice = formatTokenNotice({
      source: "proxy",
      promptTokens: 40,
      baselineTokens: 900,
      reducedTokens: 300,
      actualPromptTokens: 40,
      actualCompletionTokens: 5,
      model: "openai/gpt-4o",
      keptTools: ["Read"],
      droppedTools: ["Shell", "WebSearch"],
    });
    assert.match(notice, /Spent 40 input tokens and 5 output tokens on openai\/gpt-4o/);
    assert.match(notice, /900 to 300/);
    assert.match(notice, /Dropped Shell, WebSearch/);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
