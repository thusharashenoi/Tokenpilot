import { countTokens } from "./tokens";

export type DistillOptions = {
  url: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DISTILL_SYSTEM = `You are a system prompt distiller. Given a full system prompt and a user task, extract ONLY the rules essential for that specific task.

Rules:
1. Keep safety constraints (approval, permissions, confidential handling)
2. Keep rules directly relevant to the task
3. Drop examples, style guides, personality, background
4. Keep output under 250 tokens
5. Preserve the core identity and constraints
6. Output only the distilled system prompt, nothing else

Example:
Input System: [5000 token system prompt with examples, style guide, etc.]
Input Task: "Fix the login bug in auth.ts"
Output: "You are a coding assistant. Read files before editing. Get approval for file writes, shell commands, and git operations. Follow the repository's existing style. Make minimal changes that satisfy the task."`;

const FALLBACK_CORE = `You are a coding assistant working in the user's editor.
Read files before editing them. Get explicit approval before writing files, running shell commands, or using git.
Follow the repository's existing style. Make the smallest change that satisfies the task.
Use only the tools provided for this turn. Do not invent tool results.`;

export async function distillHarness(
  fullHarness: string,
  userPrompt: string,
  options: DistillOptions,
): Promise<{ distilled: string; tokens: { before: number; after: number; saved: number } }> {
  const before = countTokens(fullHarness);
  
  // If already small, don't bother
  if (before <= 300) {
    return {
      distilled: fullHarness,
      tokens: { before, after: before, saved: 0 },
    };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 3000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const response = await fetchImpl(completionsUrl(options.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        stream: false,
        max_tokens: 512,
        messages: [
          { role: "system", content: DISTILL_SYSTEM },
          {
            role: "user",
            content: `Full System Prompt:\n${fullHarness}\n\nUser Task:\n${userPrompt}\n\nDistilled System Prompt:`,
          },
        ],
      }),
      signal,
    });

    if (!response.ok) {
      return fallback(fullHarness);
    }

    const payload = await response.json();
    const distilled = extractContent(payload);

    if (!distilled || distilled.length < 50) {
      return fallback(fullHarness);
    }

    // Verify safety rules are preserved
    const hasSafety = /\b(approval|permission|explicit|confidential|budget|protect)\b/i.test(distilled);
    if (!hasSafety) {
      // Inject safety back
      const safe = `${distilled}\n\nWrites, shell, and git require explicit user approval. Confidential repositories use only the local model.`;
      const after = countTokens(safe);
      return {
        distilled: safe,
        tokens: { before, after, saved: before - after },
      };
    }

    const after = countTokens(distilled);
    return {
      distilled,
      tokens: { before, after, saved: before - after },
    };
  } catch (error) {
    return fallback(fullHarness);
  }
}

function fallback(fullHarness: string): { distilled: string; tokens: { before: number; after: number; saved: number } } {
  const before = countTokens(fullHarness);
  const after = countTokens(FALLBACK_CORE);
  return {
    distilled: FALLBACK_CORE,
    tokens: { before, after, saved: before - after },
  };
}

function completionsUrl(origin: string): string {
  const base = origin.replace(/\/$/, "");
  if (base.endsWith("/chat/completions")) {
    return base;
  }
  if (base.endsWith("/v1")) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function extractContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return "";
  }
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  return typeof content === "string" ? content.trim() : "";
}
