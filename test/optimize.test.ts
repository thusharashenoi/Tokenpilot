import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SYSTEM, DEFAULT_TOOLS } from "../src/core/harness";
import { formatTokenPopup, optimizeInput } from "../src/core/optimize";

test("optimizeInput keeps task text and tool selection", async () => {
  const report = await optimizeInput({
    systemPrompt: DEFAULT_SYSTEM,
    userText: "Add error handling to fetchUser in api.ts. Make sure null checks are included.",
    tools: DEFAULT_TOOLS,
    agentLabel: "cursor",
  });
  assert.ok(report.tokens.optimized < report.tokens.baseline);
  assert.ok(report.userText.includes("error handling"));
  assert.ok(report.userText.includes("null checks"));
  assert.ok(!report.userText.includes("Make sure"));
  assert.ok(report.systemPrompt.includes("approval"));
  assert.ok(!report.systemPrompt.includes("EXAMPLE_SENTINEL"));
  assert.ok(!report.systemPrompt.includes("Style guide"));
  assert.ok(report.systemPrompt.length < DEFAULT_SYSTEM.length);

  const kept = report.tools.map((tool) => tool.name);
  assert.ok(kept.includes("read_file"));
  assert.ok(kept.includes("apply_edit"));
  const omit = report.droppedTools.map((tool) => tool);
  assert.ok(omit.includes("web_search"));
  assert.strictEqual(report.task, "edit");
  const popup = formatTokenPopup(report);
  assert.ok(popup.message.includes(report.tokens.optimized.toString()));
  assert.ok(popup.message.includes(report.tokens.savedPct.toString()));
  assert.ok(popup.detail.includes(report.tokens.stages.nlp.before.toString()));
  assert.ok(popup.detail.includes(report.tokens.stages.nlp.after.toString()));
});

test("optimizeInput with rewritten text", async () => {
  const original = "Hello! I was wondering if you could please fix the bug in auth.ts. Thanks!";
  const rewritten = "Fix the bug in auth.ts";
  const report = await optimizeInput({
    systemPrompt: DEFAULT_SYSTEM,
    userText: original,
    rewrittenUserText: rewritten,
    tools: DEFAULT_TOOLS,
  });
  assert.strictEqual(report.userText, rewritten);
  assert.ok(report.tokens.saved > 0);
});

test("formatTokenPopup with actual tokens", () => {
  const report = {
    systemPrompt: "",
    userText: "",
    tools: [],
    messages: [],
    task: "edit" as const,
    actions: [],
    droppedTools: [],
    tokens: {
      baseline: 1000,
      optimized: 400,
      saved: 600,
      savedPct: 60,
      stages: { nlp: { before: 300, after: 120 }, harness: { before: 700, after: 280 } },
    },
  };
  const popup = formatTokenPopup(report, { promptTokens: 410, model: "gpt-4o-mini" });
  assert.ok(popup.detail.includes("410"));
  assert.ok(popup.detail.includes("gpt-4o-mini"));
});
