import { countTokens } from "./tokens";

export type RewriteResult = {
  text: string;
  beforeTokens: number;
  afterTokens: number;
  droppedUrls: string[];
  changed: boolean;
};

const STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "with", "this", "that",
  "it", "is", "be", "as", "at", "by", "from", "your", "you", "we", "our", "so", "can",
]);
const FILLER = /^(sure|of course|absolutely|certainly|great question|happy to|i'd be happy|i would be happy|glad to|no problem|let me|i will|i'll|here's|here is)\b/i;
const PLAN = /^(first|second|third|next|then|finally|step \d+)\b/i;
const NEGATION = /\b(not|never|no|don't|do not|without|unchanged)\b/i;
const URL = /https?:\/\/[^\s)>\]]+/g;

type Part = { kind: "code" | "prose"; text: string };

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
  if (cursor < text.length) {
    parts.push({ kind: "prose", text: text.slice(cursor) });
  }
  return parts;
}

function contentWords(text: string): Set<string> {
  const found = text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [];
  return new Set(found.filter((word) => !STOP.has(word)));
}

function overlap(sentence: string, goal: Set<string>): number {
  let count = 0;
  for (const word of contentWords(sentence)) {
    if (goal.has(word)) {
      count += 1;
    }
  }
  return count;
}

function sentencesOf(prose: string): string[] {
  return prose
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function stripUrls(text: string, allowed: Set<string> | null): { text: string; dropped: string[] } {
  if (!allowed) {
    return { text, dropped: [] };
  }
  const dropped: string[] = [];
  const next = text.replace(URL, (url) => {
    const clean = url.replace(/[.,;]+$/, "");
    if (allowed.has(clean) || allowed.has(url)) {
      return url;
    }
    dropped.push(clean);
    return "";
  });
  return {
    text: next.replace(/[ \t]{2,}/g, " ").replace(/\(\s*\)/g, "").trim(),
    dropped,
  };
}

function keepSentence(sentence: string, goal: Set<string>): boolean {
  const shared = overlap(sentence, goal);
  const filler = FILLER.test(sentence);
  const plan = PLAN.test(sentence);
  if (filler && shared < 2) {
    return false;
  }
  if (plan && shared < 2) {
    return false;
  }
  return shared >= 1 || NEGATION.test(sentence) || /\d/.test(sentence);
}

export function hasUnclosedFence(text: string): boolean {
  return (text.match(/```/g)?.length ?? 0) % 2 === 1;
}

function compressProse(prose: string, goal: Set<string>): string {
  const sentences = sentencesOf(prose);
  if (sentences.length === 0) {
    return "";
  }
  const kept = sentences.filter((sentence) => keepSentence(sentence, goal));
  const ranked = [...kept].sort((a, b) => overlap(b, goal) - overlap(a, goal));
  const preferred = new Set(ranked.slice(0, 4));
  for (const sentence of kept) {
    if (NEGATION.test(sentence)) {
      preferred.add(sentence);
    }
  }
  const chosen = kept.filter((sentence) => preferred.has(sentence)).slice(0, 6);
  if (chosen.length > 0) {
    return chosen.join(" ");
  }
  return "";
}

function declaredSignatures(note: string): string[] {
  return [...note.matchAll(/^- \S+:\s*((?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)[^.\n]*)/gm)]
    .map((match) => match[1].replace(/\s+/g, " ").trim().replace(/^(?:export\s+)?(?:async\s+)?function\s+/, "").replace(/\s*\{$/, ""));
}

export function stateNoEdit(reply: string, note: string): string {
  const signatures = declaredSignatures(note);
  if (signatures.length === 0 || reply.includes("```")) {
    return reply;
  }
  const echoed = /name the signature/i.test(reply);
  const dumped = /[\w./-]+\.ts:\s*(?:export\s+)?(?:async\s+)?function/.test(reply);
  if (!echoed && !dumped) {
    return reply;
  }
  return ["No edit is required.", ...signatures.map((signature) => `${signature} already meets the goal.`)].join("\n");
}

export function holdExistingSignatures(reply: string, note: string): string {
  const declared = [...note.matchAll(/^- \S+:\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm)];
  for (const match of declared) {
    const name = match[1];
    const params = match[2].replace(/\s+/g, "");
    const found = reply.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`));
    if (found && found[1].replace(/\s+/g, "") !== params) {
      const signature = `${name}(${match[2].replace(/\s+/g, " ").trim()})`;
      return `No edit is required. ${signature} already meets the goal.`;
    }
  }
  return reply;
}

export function rewriteReply(content: string, goal: string, allowedUrls?: string[]): RewriteResult {
  const beforeTokens = countTokens(content);
  if (!content.trim() || hasUnclosedFence(content)) {
    return { text: content, beforeTokens, afterTokens: beforeTokens, droppedUrls: [], changed: false };
  }
  const allowed = allowedUrls ? new Set(allowedUrls) : null;
  const goalWords = contentWords(goal);
  const droppedUrls: string[] = [];
  const rebuilt = splitFences(content)
    .flatMap((part) => {
      if (part.kind === "code") {
        return [part.text.trim()];
      }
      const stripped = stripUrls(part.text, allowed);
      droppedUrls.push(...stripped.dropped);
      const compressed = compressProse(stripped.text, goalWords);
      return compressed ? [compressed] : [];
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const withStatus = rebuilt;
  const afterTokens = countTokens(withStatus);
  if (afterTokens > beforeTokens && droppedUrls.length === 0) {
    return { text: content, beforeTokens, afterTokens: beforeTokens, droppedUrls, changed: false };
  }
  return {
    text: withStatus,
    beforeTokens,
    afterTokens,
    droppedUrls,
    changed: withStatus !== content,
  };
}
