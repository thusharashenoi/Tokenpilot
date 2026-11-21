const THANK_LINE =
  /^(thanks(?: so much| in advance)?|thank you(?: so much| in advance)?|many thanks|cheers|much appreciated)[.!\s]*$/i;
const FILLER_LINE =
  /^(hope (?:you(?:'| a)re|this finds you) well|just (?:a quick|wanted to)|sorry for the (?:long message|delay)|apologies)[.!\s]*$/i;
const GREETING = /^(?:hey|hi|hello|hi there|good morning|good afternoon|good evening)[,!\s]+/i;
const POLITE =
  /\b(could you please|can you please|would you please|would you mind|i need you to|i want you to|i would like you to|i was wondering if you could|i was wondering if|i was hoping you could|i'd appreciate it if you could|if you don't mind|when you get a chance|please)\b/gi;

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

function groomLine(raw: string): string {
  const line = raw
    .split(/(`[^`]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(GREETING, "").replace(POLITE, "")))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  if (!line || THANK_LINE.test(line) || FILLER_LINE.test(line)) {
    return "";
  }
  return line;
}

function compactProseBlock(block: string): string {
  const kept: string[] = [];
  for (const raw of block.replace(/\r\n/g, "\n").split("\n")) {
    const line = groomLine(raw);
    if (!line || kept[kept.length - 1] === line) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

export function compactProse(text: string): string {
  const parts = splitFences(text);
  const body = parts
    .map((part) => (part.kind === "code" ? part.text : compactProseBlock(part.text)))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body;
}
