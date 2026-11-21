import assert from "node:assert/strict";
import test from "node:test";
import { compactHistory, replaceHistory } from "../src/core/history";
import { reduceProviderPayload } from "../src/core/reduce";
import { countTokens } from "../src/core/tokens";

const essay = "The architecture is a long story about every file in the repository. ".repeat(40);
const code = `export function charge() {\n  return 1;\n}\n`.repeat(20);

function priorTurns() {
  return [
    {
      role: "user",
      text: "Hey! Please don't change charge(). Look at src/checkout.ts.\n\n```json\n" + JSON.stringify([{ sku: "SKU-9", qty: 4 }], null, 2) + "\n```",
    },
    {
      role: "assistant",
      text: `${essay}\nUpdated src/checkout.ts so guests pay. charge() still writes the ledger.\nError E_CHARGE if qty is 0.\n\`\`\`ts\n${code}\`\`\``,
    },
    {
      role: "tool",
      text: JSON.stringify({ items: [{ sku: "SKU-9", qty: 4 }] }),
    },
  ];
}

test("history becomes a short summary plus a TOON of the facts", () => {
  const turns = priorTurns();
  const pack = compactHistory(turns);
  assert.ok(pack);
  assert.match(pack.summary, /don't change charge\(\)/);
  assert.match(pack.summary, /Updated src\/checkout\.ts/);
  assert.equal(pack.summary.includes("long story"), false);
  assert.match(pack.toon, /\[.+\]\{kind,detail\}:/);
  assert.ok(pack.toon.includes("don't change charge()"));
  assert.ok(pack.toon.includes("src/checkout.ts"));
  assert.ok(pack.toon.includes("charge()"));
  assert.ok(pack.toon.includes("E_CHARGE"));
  assert.ok(pack.toon.includes("qty=0"));
  assert.match(pack.text, /\{sku,qty\}:/);
  assert.ok(pack.text.includes("SKU-9"));
  assert.equal(pack.text.includes("long story"), false);
  assert.equal(pack.text.includes("return 1;"), false);
  assert.ok(countTokens(pack.text) < countTokens(turns.map((turn) => turn.text).join("\n")));
  assert.ok(replaceHistory(turns)?.includes("Conversation so far."));
});

test("a short exchange stays as it is when the summary would cost more", () => {
  const turns = [
    { role: "user", text: "Add a button." },
    { role: "assistant", text: "Added the button." },
  ];
  assert.equal(replaceHistory(turns), null);
});

test("a chat request sends the history pack and the current prompt", () => {
  const report = reduceProviderPayload({
    model: "openai/gpt-4o",
    messages: [
      { role: "system", content: "You are Cursor.\n# Rules\nNever log the card number.\n" },
      { role: "user", content: priorTurns()[0].text },
      { role: "assistant", content: priorTurns()[1].text },
      { role: "tool", content: priorTurns()[2].text },
      { role: "user", content: "Hey! Please add a receipt line.\nThanks!" },
    ],
  });
  const messages = report.payload.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[2].role, "user");
  assert.equal(messages.length, 3);
  assert.match(messages[1].content, /Conversation so far\./);
  assert.match(messages[1].content, /\[.+\]\{kind,detail\}:/);
  assert.ok(messages[1].content.includes("don't change charge()"));
  assert.ok(messages[1].content.includes("SKU-9"));
  assert.equal(messages[1].content.includes("long story"), false);
  assert.equal(messages[1].content.includes("return 1;"), false);
  assert.ok(messages[2].content.includes("add a receipt line"));
  assert.equal(messages[2].content.includes("Thanks"), false);
  assert.equal(messages[2].content.includes("long story"), false);
  assert.ok(report.afterTokens < report.beforeTokens);
});

test("a responses transcript keeps the same history pack", () => {
  const report = reduceProviderPayload({
    model: "openai/gpt-4o",
    instructions: "Never log the card number.",
    input: [
      { type: "message", role: "user", content: "Please don't change charge(). The file is src/checkout.ts." },
      { type: "message", role: "assistant", content: `${essay} Updated src/checkout.ts.` },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Where is charge defined?" }] },
    ],
  });
  const input = report.payload.input as Array<{ role: string; content: unknown }>;
  assert.equal(input.length, 2);
  assert.equal(input[0].role, "user");
  assert.match(String(input[0].content), /don't change charge\(\)/);
  assert.equal(String(input[0].content).includes("long story"), false);
  const current = input[1].content as Array<{ text: string }>;
  assert.equal(current[0].text, "Where is charge defined?");
});
