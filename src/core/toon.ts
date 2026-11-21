import { encode } from "@toon-format/toon";
import { countTokens } from "./tokens";

const HINT =
  "Structured blocks below are TOON. A header like name[N]{fields}: introduces tabular rows.";
const MIN_SAVE = 40;

type Swap = { start: number; end: number; next: string; saved: number };

function fenceSpans(text: string): Array<{ start: number; end: number; body: string; lang: string }> {
  const spans = [];
  const fence = /```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    spans.push({
      start: index,
      end: index + match[0].length,
      lang: match[1] ?? "",
      body: match[2] ?? "",
    });
  }
  return spans;
}

function tryEncode(raw: string): { text: string; saved: number } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  let encoded: string;
  try {
    encoded = encode(value);
  } catch {
    return null;
  }
  const saved = countTokens(trimmed) - countTokens(encoded);
  if (saved < MIN_SAVE) {
    return null;
  }
  return { text: encoded, saved };
}

function scanRawJson(text: string, blocked: Array<{ start: number; end: number }>): Swap[] {
  const swaps: Swap[] = [];
  const inside = (index: number) => blocked.some((span) => index >= span.start && index < span.end);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch !== "{" && ch !== "[") || inside(i)) {
      continue;
    }
    const prev = i === 0 ? "" : text[i - 1];
    if (prev && !/\s/.test(prev)) {
      continue;
    }
    const end = balancedEnd(text, i);
    if (end === -1 || inside(end - 1)) {
      continue;
    }
    const raw = text.slice(i, end);
    if (raw.length < 80) {
      continue;
    }
    const encoded = tryEncode(raw);
    if (!encoded) {
      continue;
    }
    swaps.push({ start: i, end, next: encoded.text, saved: encoded.saved });
    i = end - 1;
  }
  return swaps;
}

function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let quote = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        quote = false;
      }
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (!open || (ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
        return -1;
      }
      if (stack.length === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

export function encodeJsonBlocks(text: string): { text: string; saved: number } {
  const fences = fenceSpans(text);
  const swaps: Swap[] = [];
  for (const fence of fences) {
    const lang = fence.lang.toLowerCase();
    if (lang !== "json" && lang !== "jsonc" && lang !== "") {
      continue;
    }
    const encoded = tryEncode(fence.body);
    if (!encoded) {
      continue;
    }
    const next = "```toon\n" + encoded.text + "\n```";
    swaps.push({ start: fence.start, end: fence.end, next, saved: encoded.saved });
  }
  swaps.push(...scanRawJson(text, fences));
  if (swaps.length === 0) {
    return { text, saved: 0 };
  }
  swaps.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let saved = 0;
  const chunks: string[] = [];
  for (const swap of swaps) {
    if (swap.start < cursor) {
      continue;
    }
    chunks.push(text.slice(cursor, swap.start), swap.next);
    cursor = swap.end;
    saved += swap.saved;
  }
  chunks.push(text.slice(cursor));
  const hintCost = countTokens(HINT);
  if (saved <= hintCost) {
    return { text, saved: 0 };
  }
  return { text: HINT + "\n\n" + chunks.join(""), saved: saved - hintCost };
}
