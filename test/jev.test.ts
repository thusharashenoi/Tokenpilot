import assert from "node:assert/strict";
import test from "node:test";
import { harnessFor } from "../src/core/agents";
import { jevAttach } from "../src/core/jev";
import { reduceProviderPayload } from "../src/core/reduce";

const cursor = harnessFor("cursor").tools;

test("an edit gets read, search, and edit tools and nothing else", () => {
  const jev = jevAttach("Add a submit button to the form.", cursor);
  assert.equal(jev.task, "edit");
  assert.deepEqual(jev.attached.sort(), ["Delete", "Glob", "Grep", "Read", "SemanticSearch", "StrReplace", "Write"]);
  assert.equal(jev.attached.includes("Shell"), false);
  assert.equal(jev.attached.includes("WebSearch"), false);
  assert.match(jev.note, /^JEV attached: /);
});

test("a lookup stays on read and search", () => {
  const jev = jevAttach("Where is charge defined?", cursor);
  assert.deepEqual(jev.attached.sort(), ["Glob", "Grep", "Read", "SemanticSearch"]);
  assert.equal(jev.attached.includes("StrReplace"), false);
});

test("tests, docs, and a commit add the tool that can do them", () => {
  assert.ok(jevAttach("Add a submit button and run the tests.", cursor).attached.includes("Shell"));
  assert.ok(jevAttach("Look up the vitest docs online.", cursor).attached.includes("WebSearch"));
  assert.equal(jevAttach("Look up the vitest docs online.", cursor).attached.includes("StrReplace"), false);
  const commit = jevAttach("Commit the current work.", cursor);
  assert.ok(commit.attached.includes("Shell"));
  assert.equal(commit.attached.includes("StrReplace"), false);
  assert.ok(jevAttach("Draft a plan for the checkout refactor.", cursor).attached.includes("TodoWrite"));
});

test("a request with no tools still receives the Cursor tools the task needs", () => {
  const report = reduceProviderPayload({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Add a receipt line to checkout." }],
  });
  const system = String((report.payload.messages as Array<{ content: string }>)[0].content);
  const sent = report.payload.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(
    sent.map((tool) => tool.function.name),
    ["Read", "Grep", "StrReplace"],
  );
  assert.match(system, /JEV attached: Read, Grep, StrReplace\./);
  assert.equal(report.task, "edit");
});

test("a partial tool list is filled so an edit can still change a file", () => {
  const report = reduceProviderPayload({
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "Update the checkout flow." }],
    tools: [
      { type: "function", function: { name: "Read", description: "Read a file span.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      { type: "function", function: { name: "Shell", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ],
  });
  assert.deepEqual(report.keptTools, ["Read", "Grep", "StrReplace"]);
  assert.ok(report.droppedTools.includes("Shell"));
});
