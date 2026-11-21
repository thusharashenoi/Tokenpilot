import assert from "node:assert/strict";
import test from "node:test";
import { applyCursorHook, formatTokenNotice, measureReducedTurn } from "../src/core/cursorTurn";

test("a finished chat turn reports the reduced input", () => {
  const prompt = "Please can you kindly add a submit button to the form. Thanks so much!";
  const measured = measureReducedTurn(prompt);
  assert.ok(measured.promptTokens < measured.baselineTokens);
  assert.ok(measured.userAfter < measured.userBefore);
  assert.ok(measured.harnessAfter < measured.harnessBefore);

  const submitted = applyCursorHook(
    { hook_event_name: "beforeSubmitPrompt", conversation_id: "chat-1", prompt },
    {},
    1,
    measured,
  );
  assert.deepEqual(submitted.response, { continue: true });
  assert.equal(submitted.notice, null);
  assert.equal(submitted.pending["chat-1"].promptTokens, measured.promptTokens);

  const finished = applyCursorHook(
    { hook_event_name: "stop", conversation_id: "chat-1", status: "completed" },
    submitted.pending,
    2,
  );
  assert.equal(finished.notice?.promptTokens, measured.promptTokens);
  const text = formatTokenNotice(finished.notice!);
  assert.match(text, /Reduced input: [\d,]+ tokens \(was [\d,]+\)/);
  assert.match(text, /Prompt \d+→\d+/);
  assert.match(text, /System and tools \d+→\d+/);
});

test("a prompt is allowed through and a failed turn stays quiet", () => {
  const submitted = applyCursorHook(
    { hook_event_name: "beforeSubmitPrompt", conversation_id: "chat-2", prompt: "Rename the header." },
    {},
    1,
  );
  const failed = applyCursorHook(
    { hook_event_name: "stop", conversation_id: "chat-2", status: "error" },
    submitted.pending,
    2,
  );
  assert.equal(failed.notice, null);
  assert.ok(submitted.pending["chat-2"].promptTokens < submitted.pending["chat-2"].baselineTokens);
});
