import { encode } from "@toon-format/toon";
import { countTokens } from "./tokens";
import { condenseUserPrompt } from "./userPrompt";

const HINT = "Structured blocks below are TOON. A header like name[N]{fields}: introduces tabular rows.";
const REQUIREMENT = /\b(don't|do not|never|must|shall|always|only|make sure|keep|preserve|avoid|should|shouldn't)\b/i;
const ERROR_LINE = /\b(error|exception|failed|failure)\b/i;
const DECISION = /\b(updated|added|removed|fixed|kept|renamed|created|deleted|wrote)\b/i;

export type HistoryTurn = { role: string; text: string };

export type HistoryFact = { kind: string; detail: string };

export type HistoryPack = {
  summary: string;
  toon: string;
  text: string;
  facts: HistoryFact[];
};

function sentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence && !sentence.startsWith("```"));
}

function pushFact(facts: HistoryFact[], seen: Set<string>, kind: string, detail: string): void {
  const clean = detail.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 240) {
    return;
  }
  const key = `${kind}:${clean.toLowerCase()}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  facts.push({ kind, detail: clean });
}

function parseJsonBlock(lang: string, body: string): unknown | null {
  const name = lang.toLowerCase();
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }
  if (name && name !== "json" && name !== "jsonc" && name !== "toon") {
    return null;
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function splitPayloads(text: string): { prose: string; values: unknown[]; snippets: string[] } {
  const values: unknown[] = [];
  const snippets: string[] = [];
  let anchors = "";
  const prose = text.replace(/```([a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g, (full, lang: string, body: string) => {
    const parsed = parseJsonBlock(lang, body);
    if (parsed) {
      values.push(parsed);
      return "\n";
    }
    if (body.length > 500 || body.split("\n").length > 12) {
      anchors += `\n${body}`;
      return "\n";
    }
    snippets.push(full.trim());
    return "\n";
  });
  const trimmed = prose.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object") {
        values.push(value);
        return { prose: anchors, values, snippets };
      }
    } catch {
      return { prose: `${prose}\n${anchors}`, values, snippets };
    }
  }
  return { prose: `${prose}\n${anchors}`, values, snippets };
}

function collectFacts(turns: HistoryTurn[]): { facts: HistoryFact[]; tables: string[]; snippets: string[] } {
  const facts: HistoryFact[] = [];
  const seen = new Set<string>();
  const tables: string[] = [];
  const snippets: string[] = [];
  const tableSeen = new Set<string>();
  for (const turn of turns) {
    const split = splitPayloads(turn.text);
    for (const value of split.values) {
      try {
        const encoded = encode(value);
        if (encoded && !tableSeen.has(encoded)) {
          tableSeen.add(encoded);
          tables.push(encoded);
        }
      } catch {
        continue;
      }
    }
    for (const snippet of split.snippets) {
      if (!snippets.includes(snippet)) {
        snippets.push(snippet);
      }
    }
    const prose = split.prose;
    for (const sentence of sentences(prose)) {
      if (REQUIREMENT.test(sentence)) {
        pushFact(facts, seen, "constraint", sentence);
      }
      if ((turn.role === "assistant" || turn.role === "tool") && DECISION.test(sentence)) {
        pushFact(facts, seen, "decision", sentence);
      }
      if (ERROR_LINE.test(sentence) && sentence.length <= 180) {
        pushFact(facts, seen, "error", sentence);
      }
    }
    for (const match of prose.matchAll(/\b(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|css|html)\b/g)) {
      pushFact(facts, seen, "path", match[0]);
    }
    for (const match of prose.matchAll(/\b[A-Za-z_][\w]*\(\)/g)) {
      pushFact(facts, seen, "symbol", match[0]);
    }
    for (const match of prose.matchAll(/\b(?:function|class|interface|type)\s+([A-Za-z_][\w]*)/g)) {
      pushFact(facts, seen, "symbol", match[1] ?? match[0]);
    }
    for (const match of prose.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
      pushFact(facts, seen, "error", match[0]);
    }
    for (const match of prose.matchAll(/\b([A-Za-z][\w.-]{1,24})\s*(?:=|:|is)\s*(-?\d+(?:\.\d+)?)\b/g)) {
      pushFact(facts, seen, "number", `${match[1]}=${match[2]}`);
    }
    for (const match of prose.matchAll(/\b[A-Z]{2,}-\d+\b/g)) {
      pushFact(facts, seen, "id", match[0]);
    }
  }
  return { facts, tables, snippets: snippets.slice(0, 2) };
}

function brief(text: string): string {
  const condensed = condenseUserPrompt(text);
  const source = condensed && countTokens(condensed) < countTokens(text) ? condensed : text;
  const line = source
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("```"));
  if (!line) {
    return "";
  }
  const sentence = line.split(/(?<=[.!?])\s+/)[0] ?? line;
  return sentence.length > 140 ? `${sentence.slice(0, 137)}...` : sentence;
}

function summarize(turns: HistoryTurn[], facts: HistoryFact[]): string {
  const asks = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => brief(turn.text))
    .filter(Boolean)
    .slice(0, 2);
  const decision = [...facts].reverse().find((fact) => fact.kind === "decision")?.detail ?? "";
  const bits = [...asks, decision].filter(Boolean);
  return bits.length > 0 ? bits.join(" Then ") : "Earlier turns.";
}

function render(summary: string, facts: HistoryFact[], tables: string[], snippets: string[]): string {
  const blocks = [HINT];
  if (facts.length > 0) {
    blocks.push("```toon", encode(facts), "```");
  }
  for (const table of tables) {
    blocks.push("```toon", table, "```");
  }
  return [`Conversation so far.`, `Summary: ${summary}`, "", ...blocks, ...snippets].filter((part) => part !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function compactHistory(turns: HistoryTurn[]): HistoryPack | null {
  const usable = turns.filter((turn) => turn.text.trim());
  if (usable.length === 0) {
    return null;
  }
  const { facts, tables, snippets } = collectFacts(usable);
  const summary = summarize(usable, facts);
  const toon = [facts.length > 0 ? encode(facts) : "", ...tables].filter(Boolean).join("\n\n");
  return { summary, toon, facts, text: render(summary, facts, tables, snippets) };
}

export function replaceHistory(turns: HistoryTurn[]): string | null {
  const pack = compactHistory(turns);
  if (!pack) {
    return null;
  }
  const raw = turns.map((turn) => turn.text).join("\n");
  if (countTokens(pack.text) >= countTokens(raw)) {
    return null;
  }
  return pack.text;
}
