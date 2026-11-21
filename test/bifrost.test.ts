import assert from "node:assert/strict";
import test from "node:test";
import { sendViaBifrost, type BifrostRequest } from "../src/core/bifrost";

function request(over: Partial<BifrostRequest>): BifrostRequest {
  return {
    via: "bifrost",
    baseUrl: "http://bifrost.local",
    path: "/v1/chat/completions",
    model: "openai/gpt-4o-mini",
    fallbacks: ["openai/gpt-4o"],
    messages: [{ role: "user", content: "hi" }],
    localBaseUrl: "http://ollama.local",
    localModel: "qwen2.5-coder:7b",
    ...over,
  };
}

test("a down cloud model fails over inside the session", async () => {
  const seen: string[] = [];
  const result = await sendViaBifrost(request({
    fetchImpl: async (url, init) => {
      seen.push(String(url));
      const body = JSON.parse(String(init?.body));
      if (body.model === "openai/gpt-4o-mini") {
        return new Response("down", { status: 503 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "patched" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }), {
        status: 200,
        headers: {
          "x-bifrost-routing-info-is-fallback": "true",
          "x-bifrost-routing-info-model": "gpt-4o",
          "x-bifrost-routing-info-provider": "openai",
        },
      });
    },
  }));
  assert.equal(result.content, "patched");
  assert.equal(result.usedFallback, true);
  assert.equal(result.modelUsed, "gpt-4o");
  assert.match(result.notifyUser ?? "", /session stays open/);
  assert.ok(seen.every((url) => url.startsWith("http://bifrost.local/v1/chat/completions")));
});

test("a dead gateway moves the same turn to the local model", async () => {
  const seen: string[] = [];
  const result = await sendViaBifrost(request({
    fetchImpl: async (url) => {
      const href = String(url);
      seen.push(href);
      if (href.startsWith("http://bifrost.local")) {
        throw new Error("connect ECONNREFUSED");
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "local ok" } }] }), { status: 200 });
    },
  }));
  assert.equal(result.content, "local ok");
  assert.match(result.notifyUser ?? "", /Bifrost is unreachable/);
  assert.ok(seen.some((url) => url.startsWith("http://ollama.local")));
});

test("confidential turns never call Bifrost", async () => {
  const seen: string[] = [];
  const result = await sendViaBifrost(request({
    via: "local",
    model: "openai/gpt-4o",
    fallbacks: ["openai/gpt-4o-mini"],
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: "stayed local" } }] }), { status: 200 });
    },
  }));
  assert.equal(result.content, "stayed local");
  assert.equal(result.modelUsed, "qwen2.5-coder:7b");
  assert.ok(seen.every((url) => url.startsWith("http://ollama.local")));
});

test("a caller error does not fail over", async () => {
  const seen: string[] = [];
  await assert.rejects(() => sendViaBifrost(request({
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response("bad request", { status: 400 });
    },
  })));
  assert.equal(seen.length, 1);
});
