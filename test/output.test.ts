import assert from "node:assert/strict";
import test from "node:test";
import { sendViaBifrost } from "../src/core/bifrost";
import { answerReady } from "../src/core/finishReply";
import { alignObjective, reasoningFor } from "../src/core/objective";
import { optimizeInput } from "../src/core/optimize";
import { scopeNote } from "../src/core/graph";
import { holdExistingSignatures, rewriteReply, stateNoEdit } from "../src/core/rewrite";
import { fetchTavilyPack, needsExternalFact } from "../src/core/tavily";
import type { ChatMessage } from "../src/core/types";

const fence = "```ts\nexport function charge(card: Card) { return card; }\n```";

test("a short finished answer is ready and a file-reading plan is not", () => {
  assert.equal(answerReady("No edit is required. charge(card, amount, guest) already meets the goal.", []), true);
  assert.equal(answerReady("May I ask permission to search the workspace for src/charge.ts?", []), true);
  assert.equal(answerReady("Let's check src/charge.ts and other files as well.", []), false);
  assert.equal(answerReady("", [{ id: "1", name: "Read", arguments: "{}" }]), false);
});

test("the objective contract is appended after input optimization", () => {
  const report = optimizeInput({
    systemPrompt: "You are a coding agent.\n\n## Response style\nBe warm and verbose.",
    userText: "Please update checkout so guests can pay.\nDon't change charge().",
    tools: [],
  });
  const aligned = alignObjective(report.messages, {
    task: report.task,
    userText: report.userText,
    files: ["src/checkout.ts"],
  });
  const system = aligned.messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(system, /Goal: /);
  assert.match(system, /Don't change charge\(\)/);
  assert.match(system, /In scope: src\/checkout.ts/);
  assert.match(system, /Answer first/);
  assert.match(system, /no edit is required/);
  const greeting = alignObjective([{ role: "user", content: "Hello" }], { task: "lookup", userText: "Hello" });
  const greetingSystem = greeting.messages.find((message) => message.role === "system")?.content ?? "";
  assert.match(greetingSystem, /one short greeting/);
  assert.equal(greetingSystem.includes("say no edit is required"), false);
  assert.equal(aligned.reasoning, "low");
  assert.equal(aligned.maxTokens, 800);
  assert.equal(aligned.messages.find((message) => message.role === "user")?.content, report.userText);
});

test("reasoning stays off when Tavily already supplied the facts", () => {
  assert.equal(reasoningFor("reason", true), "none");
  assert.equal(reasoningFor("lookup", false), "none");
  assert.equal(reasoningFor("reason", false), "medium");
  assert.equal(needsExternalFact("What is the latest checkout API", ""), true);
  assert.equal(needsExternalFact("What is the latest checkout API", "function checkout"), false);
  assert.equal(needsExternalFact("Update checkout so guests can pay", ""), false);
});

test("the rewriter keeps an on-objective answer and its code", () => {
  const reply = `Updated checkout so guests pay without an account. charge() is unchanged.\n${fence}`;
  const result = rewriteReply(reply, "update the checkout flow so guests can pay without an account");
  assert.ok(result.text.includes(fence));
  assert.match(result.text, /without an account/);
  assert.match(result.text, /unchanged/);
});

test("an unclosed fence is stored unchanged and the objective line stays out of the reply", () => {
  const open = "Cart already takes guest.\n```typescript\nexport function checkout() {\n  if";
  const kept = rewriteReply(open, "update the checkout flow so guests can pay without an account");
  assert.equal(kept.text, open);
  assert.equal(kept.changed, false);
  const gap = `Done.\n\n${fence}\n\nSure! I'd be happy to help.\n\n${fence}`;
  const closed = rewriteReply(gap, "update the checkout flow so guests can pay without an account");
  assert.equal(closed.text.includes("Objective:"), false);
  assert.ok(closed.text.includes(fence));
  assert.equal(closed.text.includes("happy to help"), false);
});

test("a reply that replaces an existing signature is stored as no edit", () => {
  const note = scopeNote(
    [
      {
        name: "charge",
        kind: "function",
        file: "src/charge.ts",
        startLine: 6,
        endLine: 25,
        signature: "export function charge(card: Card, amount: number, guest: boolean): Receipt {",
      },
    ],
    "Please don't change the public charge() signature.",
  );
  assert.match(note, /charge\(card: Card, amount: number, guest: boolean\)/);
  const invented = "```typescript\nexport function charge(user: User | undefined, amount: number, cardNumber: string): boolean {\n  console.log(cardNumber);\n}\n```";
  assert.equal(
    holdExistingSignatures(invented, note),
    "No edit is required. charge(card: Card, amount: number, guest: boolean) already meets the goal.",
  );
  assert.equal(note.includes("{"), false);
  const echoed = "No edit is required and name the signature. - src/charge.ts: export function charge(card: Card, amount: number, guest: boolean): Receipt { - src/checkout.ts: export function checkout(lines: CartLine[], card: Card, guest: boolean): Receipt {";
  const both = scopeNote(
    [
      {
        name: "charge",
        kind: "function",
        file: "src/charge.ts",
        startLine: 6,
        endLine: 25,
        signature: "export function charge(card: Card, amount: number, guest: boolean): Receipt {",
      },
      {
        name: "checkout",
        kind: "function",
        file: "src/checkout.ts",
        startLine: 5,
        endLine: 20,
        signature: "export function checkout(lines: CartLine[], card: Card, guest: boolean): Receipt {",
      },
    ],
    "update the checkout flow and do not change charge()",
  );
  assert.equal(
    stateNoEdit(echoed, both),
    [
      "No edit is required.",
      "charge(card: Card, amount: number, guest: boolean): Receipt already meets the goal.",
      "checkout(lines: CartLine[], card: Card, guest: boolean): Receipt already meets the goal.",
    ].join("\n"),
  );
});

test("closed fences stay on separate lines", () => {
  const reply = `${fence}\n\nSure! I'd be happy to help.\n\n${fence}`;
  const result = rewriteReply(reply, "update checkout so guests can pay");
  assert.equal(result.text.includes("}``````"), false);
  assert.ok(result.text.includes("```\n\n```"));
});

test("the rewriter drops filler and keeps the patch", () => {
  const reply = [
    "Sure! I'd be happy to help you with that.",
    "The weather is nice today.",
    "First I will think about lunch.",
    fence,
  ].join("\n");
  const result = rewriteReply(reply, "update checkout so guests can pay");
  assert.ok(result.text.includes(fence));
  assert.equal(result.text.includes("weather"), false);
  assert.equal(result.text.includes("happy to help"), false);
  assert.equal(result.text.includes("lunch"), false);
  assert.ok(result.afterTokens < result.beforeTokens);
});

test("cited URLs that were not in the Tavily pack are removed", () => {
  const reply = "See https://docs.example/api and https://evil.example/phish for the checkout change.";
  const result = rewriteReply(reply, "checkout change", ["https://docs.example/api"]);
  assert.match(result.text, /https:\/\/docs\.example\/api/);
  assert.equal(result.text.includes("evil.example"), false);
  assert.deepEqual(result.droppedUrls, ["https://evil.example/phish"]);
});

test("Tavily packs three short sources", async () => {
  const pack = await fetchTavilyPack("checkout api", "test-key", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_results, 3);
    assert.equal(body.include_answer, false);
    return new Response(JSON.stringify({
      results: [
        { title: "Docs", url: "https://docs.example/api", content: "x".repeat(900) },
      ],
    }), { status: 200 });
  });
  assert.deepEqual(pack.urls, ["https://docs.example/api"]);
  assert.ok(pack.text.includes("https://docs.example/api"));
  assert.ok(pack.text.length < 900);
});

test("reasoning effort is sent, then omitted when the model rejects it", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = await sendViaBifrost({
    via: "bifrost",
    baseUrl: "http://bifrost.local",
    path: "/v1/chat/completions",
    model: "openai/gpt-4o",
    fallbacks: [],
    messages,
    maxTokens: 320,
    reasoningEffort: "low",
    localBaseUrl: "http://ollama.local",
    localModel: "qwen2.5-coder:7b",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.reasoning_effort) {
        return new Response("unknown parameter reasoning_effort", { status: 400 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 3 } },
      }), { status: 200 });
    },
  });
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(bodies[0].max_tokens, 320);
  assert.equal("reasoning_effort" in bodies[1], false);
  assert.equal(result.content, "ok");
  assert.equal(result.usage?.reasoningTokens, 3);
  assert.equal(result.usedFallback, false);
});
