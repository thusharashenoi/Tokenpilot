import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { distillHarness } from "../src/core/harnessDistill";

const FULL_HARNESS = `You are a coding agent working inside the user's editor.

# Rules
Follow the repository's existing style. Prefer the smallest edit that satisfies the task.
Ask for approval before you write a file, run a shell command, or touch git.

## Examples
EXAMPLE_SENTINEL_do_not_keep
User: Please can you kindly refactor the billing module and also update the docs, the tests, the changelog, and the migration guide.
Agent: I will read every file in src, then every file in docs, then draft a long plan with ten headings and restated requirements before I change one line.
User: Add a button.
Agent: Here is a full component library, a design system, three alternative layouts, and a rewritten stylesheet.

## Style guide
Indent with two spaces. Use camelCase for functions. Use PascalCase for classes. Do not introduce a new dependency for a one-line helper.
Write error messages in the present tense. Keep exports at the bottom of the file only when the file already does that.
Prefer named exports. Avoid default exports. Avoid abbreviations in public names. Keep comments rare.
When you touch a function, leave its callers compiling. When you add a parameter, update every call site you can see.
Do not reformat unrelated files. Do not rename public symbols unless the task says so.

## Background
This agent used to paste whole repositories into the prompt. That habit is why the harness is long.
The background exists so a stripper has something real to remove. It is not guidance for the model.`;

describe("harnessDistill", () => {
  it("should return original harness if already small", async () => {
    const small = "You are a coding assistant. Read before you edit.";
    const result = await distillHarness(small, "Fix bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
    });
    
    assert.strictEqual(result.distilled, small);
    assert.strictEqual(result.tokens.saved, 0);
  });

  it("should use fallback if fetch fails", async () => {
    const mockFetch = mock.fn(() => Promise.reject(new Error("Network error")));
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.ok(result.distilled.includes("coding assistant"));
    assert.ok(result.distilled.includes("approval"));
    assert.ok(result.tokens.saved > 0);
  });

  it("should use fallback if model returns empty", async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: "" } }] }),
      } as Response),
    );
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.ok(result.distilled.includes("coding assistant"));
    assert.ok(result.tokens.saved > 0);
  });

  it("should inject safety rules if model omits them", async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: "You are a coding assistant. Make minimal changes.",
            },
          }],
        }),
      } as Response),
    );
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.ok(result.distilled.includes("approval"));
    assert.ok(result.tokens.saved > 0);
  });

  it("should keep model output if safety rules present", async () => {
    const distilled = "You are a coding assistant. Get approval for writes, shell, and git. Follow the repository style.";
    
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: { content: distilled },
          }],
        }),
      } as Response),
    );
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.strictEqual(result.distilled, distilled);
    assert.ok(result.tokens.before > result.tokens.after);
    assert.ok(result.tokens.saved > 0);
  });

  it("should handle timeout gracefully", async () => {
    const mockFetch = mock.fn(() =>
      new Promise((resolve) => setTimeout(() => resolve({} as Response), 5000)),
    );
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
      timeoutMs: 100,
    });
    
    // Should fall back to hardcoded core
    assert.ok(result.distilled.includes("coding assistant"));
    assert.ok(result.tokens.saved > 0);
  });

  it("should handle signal abort", async () => {
    const controller = new AbortController();
    controller.abort();
    
    const result = await distillHarness(FULL_HARNESS, "Fix login bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      signal: controller.signal,
    });
    
    // Should fall back immediately
    assert.ok(result.distilled.includes("coding assistant"));
    assert.ok(result.tokens.saved > 0);
  });

  it("should construct correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = mock.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: { content: "Distilled harness with approval rules." },
          }],
        }),
      } as Response);
    });
    
    await distillHarness(FULL_HARNESS, "Fix bug", {
      url: "http://localhost:11434",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.strictEqual(capturedUrl, "http://localhost:11434/v1/chat/completions");
  });

  it("should handle base URL with /v1", async () => {
    let capturedUrl = "";
    const mockFetch = mock.fn((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: { content: "Distilled harness with approval rules." },
          }],
        }),
      } as Response);
    });
    
    await distillHarness(FULL_HARNESS, "Fix bug", {
      url: "http://localhost:11434/v1",
      model: "qwen2.5:0.5b",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
    
    assert.strictEqual(capturedUrl, "http://localhost:11434/v1/chat/completions");
  });
});
