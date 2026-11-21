import assert from "node:assert/strict";
import test from "node:test";
import { harnessFor, type AgentId } from "../src/core/agents";
import { defineExternalTool, reviewToolCall } from "../src/core/harness";
import { optimizeInput } from "../src/core/optimize";

const AGENTS: AgentId[] = ["cursor", "claude-code", "copilot"];

async function names(agent: AgentId, prompt: string): Promise<string[]> {
  const harness = harnessFor(agent);
  const report = await optimizeInput({
    systemPrompt: harness.systemPrompt,
    userText: prompt,
    tools: harness.tools,
    agentLabel: harness.label,
  });
  return report.tools.map((tool) => tool.name);
}

test("each product harness drops boilerplate and keeps the rules", async () => {
  for (const agent of AGENTS) {
    const harness = harnessFor(agent);
    const report = await optimizeInput({
      systemPrompt: harness.systemPrompt,
      userText: "Add a submit button to the form.",
      tools: harness.tools,
      agentLabel: harness.label,
    });
    assert.ok(report.tokens.optimized < report.tokens.baseline, agent);
    assert.ok(report.systemPrompt.includes(`KEEP_RULE_${agent}`), agent);
    assert.ok(!report.systemPrompt.includes(`DROP_EXAMPLE_${agent}`), agent);
    assert.ok(!report.systemPrompt.includes(`DROP_STYLE_${agent}`), agent);
    assert.ok(!report.systemPrompt.includes(`DROP_PERSONA_${agent}`), agent);
    const kept = report.systemPrompt.split(/\s+/).filter((word) => word.startsWith("KEEP_RULE_"));
    assert.ok(kept.length >= 1, `${agent} should preserve KEEP_RULE_* sentences.`);
    assert.ok(report.actions.length > 0, `${agent} actions should be non-empty.`);
    assert.strictEqual(report.tools.length, harness.tools.length, `${agent} should keep all tools for this task.`);
  }
});

test("inferToolTags reads and edit", async () => {
  const read = await names("cursor", "What does getUserProfile do?");
  assert.ok(read.includes("read_file"));
  const edit = await names("cursor", "Add type hints to getUser.");
  assert.ok(edit.includes("read_file"));
  assert.ok(edit.includes("apply_edit"));
});

test("inferToolTags shell and web", async () => {
  const shell = await names("cursor", "Run the unit tests in tests/auth.test.ts");
  assert.ok(shell.includes("run_shell"));
  const web = await names("cursor", "Search the web for the next.js image optimization docs.");
  assert.ok(web.includes("web_search"));
});

test("inferToolTags git", async () => {
  const git = await names("cursor", "Check git status and commit the changes.");
  assert.ok(git.includes("git_status"));
  assert.ok(git.includes("git_commit"));
});

test("defineExternalTool with known names", () => {
  const read = defineExternalTool("read_file", "Read a file from disk.", {});
  assert.ok(read.tags.includes("read"));
  const edit = defineExternalTool("str_replace", "Replace text in a file.", {});
  assert.ok(edit.tags.includes("edit"));
  const shell = defineExternalTool("run_shell", "Run a shell command.", {});
  assert.ok(shell.tags.includes("shell"));
});

test("defineExternalTool with unknown name", () => {
  const unknown = defineExternalTool("custom_action", "Perform a custom action.", {});
  assert.strictEqual(unknown.tags.length, 0);
});

test("reviewToolCall approval", () => {
  assert.ok(reviewToolCall("read_file", false).proceed);
  assert.ok(!reviewToolCall("apply_edit", false).proceed);
  assert.ok(reviewToolCall("apply_edit", true).proceed);
  assert.ok(!reviewToolCall("run_shell", false).proceed);
  assert.ok(reviewToolCall("run_shell", true).proceed);
});
