import { compactProse } from "./nlp";
import { countTokens } from "./tokens";

export const DEFAULT_REWRITE_MODEL = "qwen2.5:1.5b";

const REWRITE_SYSTEM = [
  "Rewrite the user task into the shortest prompt that keeps every requirement.",
  "Keep constraints, paths, symbols, numbers, and errors.",
  "Drop greetings, background, and repetition.",
  "Do not add anything.",
  "Output only the rewritten task.",
].join(" ");

const THANKS = /^(thanks|thank you|many thanks|cheers|much appreciated)\b/i;
const FILLER = /^(hope you|hope this|sorry for|apologies|just a quick|just wanted)\b/i;
const NOISE = /^(here is|here's|below is|attached is|for context|for background|fyi|quick note|as you know|let me explain|to give you)\b/i;
const COMMENTARY = /^(i think|i feel|i believe|i was|i am|i'm|in my opinion|just wondering|let me know|as mentioned|anyway)\b/i;
const LEAD =
  /^(?:i really need you to|i need you to|i want you to|i would like you to|i was wondering if you could|i was hoping you could|can you|could you|would you|please|kindly|just)\s+/i;
const TASK_START =
  /^(update|fix|add|remove|delete|rename|implement|refactor|describe|explain|find|change|write|create|move|replace|check|show|list|make|look|who|where)\b/i;
const REQUIREMENT = /\b(don't|do not|never|must|shall|always|only|make sure|keep|preserve|avoid|should|shouldn't)\b/i;
const STRONG = /\b(don't|do not|never|must|shall)\b/i;
const PATH = /\b(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|css|html)\b/;
const CALL = /\b[A-Za-z_][\w]*\(\)/;
const ERROR_CODE = /\b[A-Z][A-Z0-9_]{2,}\b/;
const STOP = new Set([
  "the", "and", "you", "for", "are", "was", "can", "but", "with", "that", "this", "from", "have", "your", "just",
  "into", "about", "there", "they", "them", "then", "than", "when", "what", "which", "while", "also", "some",
  "more", "been", "were", "will", "each", "such", "very", "really", "please", "thanks",
]);

type Part = { kind: "code" | "prose"; text: string };

export type RewriteOptions = {
  url?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function splitFences(text: string): Part[] {
  const parts: Part[] = [];
  const fence = /```[\s\S]*?```/g;
  let cursor = 0;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ kind: "prose", text: text.slice(cursor, index) });
    }
    parts.push({ kind: "code", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ kind: "prose", text: text.slice(cursor) });
  }
  return parts;
}

function proseOf(text: string): string {
  return splitFences(text)
    .filter((part) => part.kind === "prose")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function stripLead(text: string): string {
  let next = text.trim();
  let previous = "";
  while (next && next !== previous) {
    previous = next;
    next = next.replace(LEAD, "").trim();
  }
  return next.replace(/[ \t]{2,}/g, " ").trim();
}

function breakClauses(line: string): string[] {
  return line
    .split(/\s*(?:;\s+|(?<=[.!?])\s+|\s+and\s+also\s+|\s+so\s+i\b)/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasHardAnchor(sentence: string): boolean {
  return PATH.test(sentence) || CALL.test(sentence) || ERROR_CODE.test(sentence) || /`[^`]+`/.test(sentence) || /\b\d/.test(sentence);
}

function keepSentence(sentence: string): boolean {
  if (!sentence) {
    return false;
  }
  if ((COMMENTARY.test(sentence) || THANKS.test(sentence) || FILLER.test(sentence)) && !hasHardAnchor(sentence) && !STRONG.test(sentence)) {
    return false;
  }
  if ((NOISE.test(sentence) || THANKS.test(sentence) || FILLER.test(sentence)) && !hasHardAnchor(sentence) && !TASK_START.test(sentence) && !REQUIREMENT.test(sentence)) {
    return false;
  }
  return TASK_START.test(sentence) || REQUIREMENT.test(sentence) || hasHardAnchor(sentence);
}

function pushUnique(kept: string[], sentence: string): void {
  const key = sentence.toLowerCase();
  if (!kept.some((item) => item.toLowerCase() === key)) {
    kept.push(sentence);
  }
}

function condenseProse(prose: string): string {
  const kept: string[] = [];
  for (const raw of prose.replace(/\r\n/g, "\n").split("\n")) {
    for (const piece of breakClauses(raw)) {
      const sentence = stripLead(piece);
      if (keepSentence(sentence)) {
        pushUnique(kept, sentence);
      }
    }
  }
  return kept.join("\n");
}

export function condenseUserPrompt(text: string): string {
  const compacted = compactProse(text);
  if (!compacted) {
    return "";
  }
  const chunks: string[] = [];
  for (const part of splitFences(compacted)) {
    if (part.kind === "code") {
      chunks.push(part.text);
      continue;
    }
    const prose = condenseProse(part.text);
    if (prose) {
      chunks.push(prose);
    }
  }
  const condensed = chunks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return condensed || compacted;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function contentWords(text: string): string[] {
  const source = text
    .replace(/`([^`]+)`/g, " $1 ")
    .toLowerCase()
    .replace(/don't/g, "do not")
    .replace(/can't/g, "can not")
    .replace(/[^a-z0-9./+-]+/g, " ");
  const words: string[] = [];
  for (const word of source.split(/\s+/)) {
    if (!word || STOP.has(word) || word.length < 3) {
      continue;
    }
    words.push(word);
  }
  return words;
}

function constraintSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const raw of proseOf(text).split("\n")) {
    for (const piece of breakClauses(raw)) {
      const sentence = stripLead(piece);
      if (sentence && REQUIREMENT.test(sentence)) {
        pushUnique(sentences, sentence);
      }
    }
  }
  return sentences;
}

function covers(fallback: string, candidate: string): boolean {
  const hay = norm(candidate);
  for (const sentence of constraintSentences(fallback)) {
    if (!hay.includes(norm(sentence))) {
      return false;
    }
  }
  const present = new Set(contentWords(proseOf(candidate)));
  for (const word of contentWords(proseOf(fallback))) {
    if (!present.has(word)) {
      return false;
    }
  }
  for (const match of proseOf(fallback).match(/\b[A-Za-z_][\w]*\(\)/g) ?? []) {
    if (!hay.includes(match.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function restore(fallback: string, candidate: string): string {
  if (covers(fallback, candidate)) {
    return candidate;
  }
  const missing = constraintSentences(fallback).filter((sentence) => !norm(candidate).includes(norm(sentence)));
  const words = new Set(contentWords(proseOf(candidate)));
  const extra = proseOf(fallback)
    .split("\n")
    .map((line) => stripLead(line))
    .filter((line) => line && contentWords(line).some((word) => !words.has(word)));
  return [candidate.trim(), ...missing, ...extra].filter(Boolean).join("\n");
}

function groundedProse(fallback: string, modelText: string): string {
  const allowed = new Set(contentWords(proseOf(fallback)));
  const kept: string[] = [];
  const prose = splitFences(modelText)
    .filter((part) => part.kind === "prose")
    .map((part) => part.text)
    .join("\n");
  for (const raw of prose.split("\n")) {
    for (const piece of breakClauses(raw)) {
      const sentence = stripLead(piece);
      if (!sentence || THANKS.test(sentence) || FILLER.test(sentence) || isAddedCommentary(sentence)) {
        continue;
      }
      const words = contentWords(sentence);
      if (words.length === 0 || words.some((word) => !allowed.has(word))) {
        continue;
      }
      pushUnique(kept, sentence);
    }
  }
  return kept.join("\n");
}

function isAddedCommentary(sentence: string): boolean {
  return /^(sure|certainly|here is|here's|rewritten prompt|concise version)\b/i.test(sentence);
}

function stripPreamble(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^(?:sure[,!]?\s+|certainly[,!]?\s+)?(?:here(?:'s| is) (?:the )?(?:rewritten|concise) (?:prompt|version):?\s*)/i, "");
  const wrapped = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (wrapped) {
    text = wrapped[1].trim();
  }
  return text.trim();
}

function assemble(original: string, prose: string): string {
  const parts = splitFences(original);
  let used = false;
  let out = "";
  for (const part of parts) {
    if (part.kind === "code") {
      if (out && !out.endsWith("\n")) {
        out += "\n\n";
      }
      out += part.text;
      continue;
    }
    if (!used) {
      used = true;
      if (prose.trim()) {
        out += prose.trim();
      }
    }
  }
  if (!used) {
    out = prose.trim();
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function settleRewrite(original: string, modelText: string): string {
  const fallback = condenseUserPrompt(original);
  const grounded = groundedProse(fallback, stripPreamble(modelText));
  if (!grounded) {
    return fallback;
  }
  const candidate = condenseUserPrompt(restore(fallback, assemble(original, grounded)));
  if (!candidate || !covers(fallback, candidate)) {
    return fallback;
  }
  if (countTokens(candidate) >= countTokens(fallback)) {
    return fallback;
  }
  return candidate;
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

function completionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    return "";
  }
  const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

async function complete(options: RewriteOptions, prose: string): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 2000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(completionsUrl(options.url || ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: options.model || DEFAULT_REWRITE_MODEL,
      temperature: 0,
      stream: false,
      max_tokens: 384,
      messages: [
        { role: "system", content: REWRITE_SYSTEM },
        { role: "user", content: prose },
      ],
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Rewrite model returned ${response.status}.`);
  }
  return completionText(await response.json());
}

export type RewriteTrace = {
  text: string;
  source: "skipped" | "failed" | "dropped" | "kept";
};

export async function traceUserPrompt(text: string, options: RewriteOptions = {}): Promise<RewriteTrace> {
  const fallback = condenseUserPrompt(text);
  if (!options.url || countTokens(proseOf(text)) <= 40) {
    return { text: fallback, source: "skipped" };
  }
  try {
    const raw = await complete(options, proseOf(compactProse(text)));
    if (!raw.trim()) {
      return { text: fallback, source: "dropped" };
    }
    const settled = settleRewrite(text, raw);
    return { text: settled, source: settled === fallback ? "dropped" : "kept" };
  } catch {
    return { text: fallback, source: "failed" };
  }
}

export async function rewriteUserPrompt(text: string, options: RewriteOptions = {}): Promise<string> {
  return (await traceUserPrompt(text, options)).text;
}
