import assert from "node:assert/strict";
import test from "node:test";
import { buildCustomPrompt, CUSTOM_HARNESS, GREETING_HARNESS, runCustomHarness } from "../src/core/customHarness";

const items = Array.from({ length: 24 }, (_, index) => ({
  sku: `SKU-${index + 1}`,
  name: `Line item ${index + 1}`,
  qty: (index % 4) + 1,
  price: Number((3 + index * 1.25).toFixed(2)),
}));

const task = [
  "Hey! I was wondering if you could please help me out with this.",
  "I need you to update the checkout flow so guests can pay without an account.",
  "Please don't change the public charge() signature, and never log the card number.",
  "",
  "```json",
  JSON.stringify({ items }, null, 2),
  "```",
  "",
  "Thanks so much!",
].join("\n");

test("the custom prompt keeps the constraint and packs the JSON", async () => {
  const built = await buildCustomPrompt(task);
  assert.match(CUSTOM_HARNESS, /smallest change/);
  assert.equal(CUSTOM_HARNESS.includes("pair programmer"), false);
  assert.match(built.user, /charge\(\)/);
  assert.match(built.user, /never log the card number/i);
  assert.equal(built.user.includes("Thanks so much"), false);
  assert.ok(built.promptAfter < built.promptBefore);
});

test("a greeting is answered as a greeting", async () => {
  const built = await buildCustomPrompt("hi");
  assert.equal(built.system, GREETING_HARNESS);
  assert.equal(built.user, "hi");
  assert.equal(built.stages, "ollama skipped, toon 0");
  assert.equal(built.system.includes("no edit"), false);
  const calls: string[] = [];
  const result = await runCustomHarness({
    task: "hi",
    localUrl: "http://127.0.0.1:11434",
    bifrostUrl: "http://localhost:8080",
    bifrostPath: "/v1/chat/completions",
    model: "gemini/gemini-3.5-flash-lite",
    workspaceRoot: "/tmp/does-not-matter",
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[0].content, GREETING_HARNESS);
      assert.equal(body.messages[1].content, "hi");
      return new Response(JSON.stringify({
        model: "gemini/gemini-3.5-flash-lite",
        choices: [{ message: { content: "No edit is required." } }],
        usage: { prompt_tokens: 20, completion_tokens: 11 },
      }), { status: 200 });
    },
  });
  assert.equal(calls.some((url) => url.includes("11434")), false);
  const reply = (result.body.choices as Array<{ message: { content: string } }>)[0].message.content;
  assert.equal(reply, "Hi.");
});

test("the coding call goes to Bifrost and the stored reply drops filler", async () => {
  const calls: string[] = [];
  const result = await runCustomHarness({
    task,
    localUrl: "http://127.0.0.1:11434",
    rewriteModel: "qwen2.5:0.5b",
    bifrostUrl: "http://localhost:8080",
    bifrostPath: "/v1/chat/completions",
    model: "gemini/gemini-3.5-flash-lite",
    fetchImpl: async (url, init) => {
      const target = String(url);
      calls.push(target);
      const body = JSON.parse(String(init?.body));
      if (target.includes("11434")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "Update checkout so guests can pay.\nDon't change charge() and never log the card number." } }] }), { status: 200 });
      }
      assert.equal(body.model, "gemini/gemini-3.5-flash-lite");
      assert.match(body.messages[0].content, /smallest change/);
      assert.equal(body.tools, undefined);
      return new Response(JSON.stringify({
        model: "gemini/gemini-3.5-flash-lite",
        choices: [{ message: { content: "Sure! I'd be happy to help.\nNo edit is required. charge() stays unchanged.\n```ts\nexport function charge(card: Card, amount: number, guest: boolean) { return card; }\n```" } }],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }), { status: 200 });
    },
  });
  assert.ok(calls.some((url) => url.includes("11434")));
  assert.ok(calls.some((url) => url.includes("localhost:8080")));
  const reply = (result.body.choices as Array<{ message: { content: string } }>)[0].message.content;
  assert.equal(reply.includes("happy to help"), false);
  assert.match(reply, /charge\(\)/);
  assert.match(reply, /```ts/);
});
