import assert from "node:assert/strict";
import http from "http";
import test from "node:test";
import { reduceProviderPayload } from "../src/core/reduce";
import { countTokens } from "../src/core/tokens";
import { prepareUpstreamBody } from "../src/core/proxy";
import { condenseUserPrompt, rewriteUserPrompt, settleRewrite, traceUserPrompt } from "../src/core/userPrompt";

const task = [
  "Hey! I was wondering if you could please help me out with this.",
  "I need you to update the checkout flow so guests can pay without an account.",
  "Please don't change the public charge() signature, and never log the card number.",
  "I think the naming is a bit messy and we should talk about it later.",
  "Here is the current payload:",
  "",
  "```json",
  JSON.stringify([{ sku: "SKU-1", qty: 2 }], null, 2),
  "```",
  "",
  "Thanks so much!",
].join("\n");

test("the user prompt keeps the requirement and drops the rest", () => {
  const out = condenseUserPrompt(task);
  assert.ok(out.includes("update the checkout flow so guests can pay without an account"));
  assert.ok(out.includes("don't change the public charge() signature, and never log the card number"));
  assert.ok(out.includes("```json"));
  assert.ok(out.includes("SKU-1"));
  assert.equal(out.includes("Thanks"), false);
  assert.equal(out.includes("Hey"), false);
  assert.equal(out.includes("I think the naming"), false);
  assert.equal(out.includes("Here is the current payload"), false);
  assert.equal(out.includes("I was wondering"), false);
  assert.ok(countTokens(out) < countTokens(task));
  assert.equal(condenseUserPrompt(out), out);
});

test("a path, a number, and a code fence stay verbatim", () => {
  const raw = [
    "Just wanted to flag this.",
    "Null receipt in checkout.ts when qty is 0.",
    "```ts",
    "const please = 1;",
    "```",
    "Don't change charge().",
  ].join("\n");
  const out = condenseUserPrompt(raw);
  assert.ok(out.includes("Null receipt in checkout.ts when qty is 0."));
  assert.ok(out.includes("```ts\nconst please = 1;\n```"));
  assert.ok(out.includes("Don't change charge()."));
  assert.equal(out.includes("Just wanted"), false);
});

test("a shorter model draft replaces the prompt only when every requirement survives", () => {
  const fallback = condenseUserPrompt(task);
  const draft = [
    "Sure, here's the concise version:",
    "Update checkout flow: guests pay without an account.",
    "don't change the public charge() signature, and never log the card number.",
    "Also migrate the database to postgres.",
  ].join("\n");
  const out = settleRewrite(task, draft);
  assert.ok(countTokens(out) < countTokens(fallback));
  assert.ok(out.includes("don't change the public charge() signature, and never log the card number"));
  assert.ok(out.includes("without an account"));
  assert.ok(out.includes("```json"));
  assert.ok(out.includes("SKU-1"));
  assert.equal(out.includes("postgres"), false);
  assert.equal(out.includes("concise version"), false);
  assert.equal(out.includes("I think the naming"), false);
});

test("a model draft that drops a constraint is rejected", () => {
  const draft = "Update the checkout flow so guests can pay without an account.";
  const out = settleRewrite(task, draft);
  assert.equal(out, condenseUserPrompt(task));
  assert.ok(out.includes("never log the card number"));
});

test("a local model rewrites the user prompt and a failure falls back", async () => {
  const requests: Array<{ model?: string; system?: string; user?: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
      requests.push({
        model: body.model,
        system: body.messages?.find((message) => message.role === "system")?.content,
        user: body.messages?.find((message) => message.role === "user")?.content,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  "Update checkout flow: guests pay without an account.",
                  "don't change the public charge() signature, and never log the card number.",
                  "Also migrate the database to postgres.",
                ].join("\n"),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  try {
    const out = await rewriteUserPrompt(task, {
      url: `http://127.0.0.1:${port}`,
      model: "qwen2.5:0.5b",
      fetchImpl: fetch,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, "qwen2.5:0.5b");
    assert.match(requests[0].system ?? "", /Do not add anything/);
    assert.equal(requests[0].user?.includes("SKU-1"), false);
    assert.equal(requests[0].user?.includes("```"), false);
    assert.ok(countTokens(out) < countTokens(condenseUserPrompt(task)));
    assert.ok(out.includes("never log the card number"));
    assert.equal(out.includes("postgres"), false);
    assert.ok(out.includes("SKU-1"));

    const failed = await rewriteUserPrompt(task, {
      url: `http://127.0.0.1:${port}`,
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    assert.equal(failed, condenseUserPrompt(task));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a draft that drops a constraint is marked dropped", async () => {
  const trace = await traceUserPrompt(task, {
    url: "http://ollama.local",
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "Update the checkout flow." } }] }), { status: 200 }),
  });
  assert.equal(trace.source, "dropped");
  assert.equal(trace.text, condenseUserPrompt(task));
});

test("a short prompt does not call the model", async () => {
  let called = false;
  const out = await rewriteUserPrompt("Where is charge defined?", {
    url: "http://127.0.0.1:9",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });
  assert.equal(called, false);
  assert.equal(out, "Where is charge defined?");
});

test("the forwarded user prompt is the concise rewrite", async () => {
  const report = await prepareUpstreamBody(
    {
      model: "openai/gpt-4o",
      messages: [
        { role: "system", content: "You are Cursor.\n# Rules\nNever log the card number.\n" },
        { role: "user", content: task },
      ],
    },
    async () => "Update the checkout flow in cart.ts.\nDon't change charge().",
  );
  const messages = report.payload.messages as Array<{ role: string; content: string }>;
  const user = messages[1].content;
  assert.ok(user.includes("cart.ts"));
  assert.ok(user.includes("Don't change charge()"));
  assert.equal(user.includes("Thanks"), false);
  assert.equal(user.includes("I think the naming"), false);
  assert.ok(countTokens(user) < countTokens(task));

  const withImage = reduceProviderPayload(
    {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Please describe this.\nThanks!" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
      ],
    },
    "Describe the receipt in checkout.ts.",
  );
  const imageMessage = (withImage.payload.messages as Array<{ role: string; content: unknown }>).find((message) => message.role === "user");
  const parts = imageMessage?.content as Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
  }>;
  assert.match(parts[0].text ?? "", /checkout\.ts/);
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url?.url, "data:image/png;base64,abc");
});
