import assert from "node:assert/strict";
import test from "node:test";
import { harnessFor, type AgentId } from "../src/core/agents";
import { defineExternalTool, reviewToolCall } from "../src/core/harness";
import { optimizeInput } from "../src/core/optimize";

const AGENTS: AgentId[] = ["cursor", "claude-code", "copilot"];

function names(agent: AgentId, prompt: string): string[] {
  const harness = harnessFor(agent);
  const report = optimizeInput({
    systemPrompt: harness.systemPrompt,
    userText: prompt,
    tools: harness.tools,
    agentLabel: harness.label,
  });
  return report.tools.map((tool) => tool.name);
}

test("each product harness drops boilerplate and keeps the rules", () => {
  for (const agent of AGENTS) {
    const harness = harnessFor(agent);
    const report = optimizeInput({
      systemPrompt: harness.systemPrompt,
      userText: "Add a submit button to the form.",
      tools: harness.tools,
      agentLabel: harness.label,
    });
    assert.ok(report.tokens.optimized < report.tokens.baseline, agent);
    assert.ok(report.systemPrompt.includes(`KEEP_RULE_${agent}`), agent);
    assert.ok(report.systemPrompt.includes("Do not log secrets"), agent);
    assert.ok(report.systemPrompt.includes("require explicit user approval"), agent);
    assert.equal(report.systemPrompt.includes(`DROP_EXAMPLE_${agent}`), false, agent);
    assert.equal(report.systemPrompt.includes(`DROP_TONE_${agent}`), false, agent);
    assert.equal(report.systemPrompt.includes(`DROP_IDENTITY_${agent}`), false, agent);
    assert.equal(report.systemPrompt.includes(`DROP_INLINE_${agent}`), false, agent);
    assert.match(report.actions.join("\n"), new RegExp(`${harness.label} kept \\d+ of ${harness.tools.length} tools`));
    for (const tool of report.tools) {
      assert.equal(tool.description.includes("The long form repeats"), false, tool.name);
    }
  }
});

test("an edit sends read, search, and edit tools only", () => {
  assert.deepEqual(names("cursor", "Add a submit button to the form.").sort(), [
    "Delete",
    "Glob",
    "Grep",
    "Read",
    "SemanticSearch",
    "StrReplace",
    "Write",
  ]);
  assert.deepEqual(names("claude-code", "Add a submit button to the form.").sort(), [
    "Edit",
    "Glob",
    "Grep",
    "MultiEdit",
    "NotebookEdit",
    "Read",
    "Write",
  ]);
  assert.deepEqual(names("copilot", "Add a submit button to the form.").sort(), [
    "create_file",
    "file_search",
    "get_errors",
    "grep_search",
    "insert_edit_into_file",
    "list_dir",
    "read_file",
    "replace_string_in_file",
    "semantic_search",
  ]);
});

test("a lookup omits edits, and a commit uses the shell when that agent has no git tool", () => {
  const lookup = names("cursor", "Where is charge defined?");
  assert.deepEqual(lookup.sort(), ["Glob", "Grep", "Read", "SemanticSearch"]);
  const commit = names("claude-code", "Commit the current work.");
  assert.ok(commit.includes("Bash"));
  assert.equal(commit.includes("Edit"), false);
  assert.equal(commit.includes("TodoWrite"), false);
  assert.ok(names("copilot", "Commit the current work.").includes("run_in_terminal"));
  assert.ok(names("copilot", "Commit the current work.").includes("get_changed_files"));
  assert.equal(names("copilot", "Commit the current work.").includes("replace_string_in_file"), false);
});

test("shell, web, and plan tools stay off the turn until the prompt asks", () => {
  const plain = names("cursor", "Add a submit button to the form.");
  assert.equal(plain.includes("Shell"), false);
  assert.equal(plain.includes("WebSearch"), false);
  assert.equal(plain.includes("TodoWrite"), false);
  const tested = names("cursor", "Add a submit button and run the tests.");
  assert.ok(tested.includes("Shell"));
  assert.ok(tested.includes("StrReplace"));
  const online = names("claude-code", "Look up the vitest docs online.");
  assert.ok(online.includes("WebSearch"));
  assert.equal(online.includes("Edit"), false);
  const plan = names("cursor", "Draft a plan for the checkout refactor.");
  assert.ok(plan.includes("TodoWrite"));
  assert.ok(plan.includes("Task"));
});

test("a named extra tool is kept and writes still need approval", () => {
  const harness = harnessFor("cursor");
  const report = optimizeInput({
    systemPrompt: harness.systemPrompt,
    userText: "Add a submit button, and use GenerateImage for the empty state.",
    tools: [...harness.tools, defineExternalTool("dance", "Dance between files. Then do it again.", { type: "object", properties: {} })],
  });
  assert.ok(report.tools.some((tool) => tool.name === "GenerateImage"));
  assert.equal(report.tools.some((tool) => tool.name === "dance"), false);
  assert.equal(reviewToolCall("Read", false).proceed, true);
  assert.equal(reviewToolCall("Bash", false).proceed, false);
  assert.equal(reviewToolCall("StrReplace", false).proceed, false);
  assert.equal(reviewToolCall("run_in_terminal", false).proceed, false);
  assert.equal(reviewToolCall("StrReplace", true).proceed, true);
});
