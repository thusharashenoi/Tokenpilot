import type { ToolDef, ToolTag } from "./harness";
import { classifyTask, type TaskKind } from "./route";

const QUERY = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
const PATH_SPAN = {
  type: "object",
  properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } },
  required: ["path"],
};
const EDIT = {
  type: "object",
  properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
  required: ["path", "oldString", "newString"],
};
const COMMAND = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
const EMPTY = { type: "object", properties: {} };

function cursorTool(name: string, tags: ToolTag[], description: string, parameters: Record<string, unknown>): ToolDef {
  return {
    name,
    description,
    parameters,
    tags,
    requiresApproval: tags.some((tag) => tag === "edit" || tag === "shell" || tag === "git"),
  };
}

const PRIMARIES: Array<[ToolTag, ToolDef]> = [
  ["read", cursorTool("Read", ["read"], "Read a span of a file the task named.", PATH_SPAN)],
  ["search", cursorTool("Grep", ["search"], "Search file contents for a pattern.", QUERY)],
  ["edit", cursorTool("StrReplace", ["edit"], "Replace one span in a file.", EDIT)],
  ["shell", cursorTool("Shell", ["shell"], "Run a shell command in the workspace.", COMMAND)],
  ["web", cursorTool("WebSearch", ["web"], "Search the public web.", QUERY)],
  ["meta", cursorTool("TodoWrite", ["meta"], "Rewrite the session todo list.", EMPTY)],
];

export type JevAttachment = {
  task: TaskKind;
  tools: ToolDef[];
  attached: string[];
  omitted: string[];
  note: string;
};

function tagsFor(task: TaskKind, userText: string): Set<ToolTag> {
  const tags = new Set<ToolTag>(["read", "graph"]);
  if (task === "edit") {
    tags.add("edit");
    tags.add("search");
  } else if (task === "lookup" || task === "reason") {
    tags.add("search");
  }
  if (/\b(tests?|npm|pnpm|yarn|shell|terminal|lint|build)\b/i.test(userText)) {
    tags.add("shell");
  }
  if (/\b(git|commit|branch|pull request|\bpr\b|merge|rebase)\b/i.test(userText)) {
    tags.add("git");
  }
  if (/\b(web|docs|tavily|internet|online)\b/i.test(userText)) {
    tags.add("web");
  }
  if (/\b(plan|todo|subagent|delegate|switch mode)\b/i.test(userText)) {
    tags.add("meta");
  }
  return tags;
}

function mentionsTool(userText: string, name: string): boolean {
  const raw = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${raw}\\b`, "i").test(userText)) {
    return true;
  }
  const spaced = name.toLowerCase().replace(/[_-]/g, " ");
  if (spaced === name.toLowerCase()) {
    return false;
  }
  const pattern = spaced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${pattern}\\b`, "i").test(userText);
}

export function jevAttach(prompt: string, catalog: ToolDef[]): JevAttachment {
  const task = classifyTask(prompt);
  const allow = tagsFor(task, prompt);
  const hasGitWrite = catalog.some((tool) => tool.tags.includes("git") && /commit|branch|merge|rebase/i.test(tool.name));
  if (allow.has("git") && !hasGitWrite) {
    allow.add("shell");
  }
  const selected = catalog.filter((tool) => tool.tags.some((tag) => allow.has(tag)) || mentionsTool(prompt, tool.name));
  for (const [tag, primary] of PRIMARIES) {
    if (!allow.has(tag) || selected.some((tool) => tool.tags.includes(tag) || tool.name === primary.name)) {
      continue;
    }
    selected.push(primary);
  }
  const attached = selected.map((tool) => tool.name);
  const omitted = catalog.filter((tool) => !selected.some((next) => next.name === tool.name)).map((tool) => tool.name);
  const note = attached.length > 0 ? `JEV attached: ${attached.join(", ")}.` : "JEV attached no tools.";
  return { task, tools: selected, attached, omitted, note };
}
