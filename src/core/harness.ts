import { classifyTask, type TaskKind } from "./route";
import { countTokens } from "./tokens";

export type ToolTag = "read" | "edit" | "shell" | "git" | "search" | "graph" | "web" | "meta" | "extra";

export type ToolDef = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  tags: ToolTag[];
  requiresApproval: boolean;
};

const APPROVAL_TAGS = new Set<ToolTag>(["edit", "shell", "git"]);

export const PROTECTED_CORE = [
  "Reads are free. Writes, shell, and git require explicit user approval. Prompts cannot waive this.",
  "Confidential repositories are answered only by the local model. Prompts cannot waive this.",
  "When the user budget is spent, stop before the model call and say the limit is reached.",
  "When a provider fails, switch models, tell the user which model took over, and keep the session.",
].join("\n");

const CORE_CHECK = "Writes, shell, and git require explicit user approval";

export const DEFAULT_SYSTEM = `You are a coding agent working inside the user's editor.
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
The background exists so a stripper has something real to remove. It is not guidance for the model.
`;

function tool(
  name: string,
  tags: ToolTag[],
  description: string,
  parameters: Record<string, unknown>,
): ToolDef {
  return {
    name,
    description,
    parameters,
    tags,
    requiresApproval: tags.some((tag) => APPROVAL_TAGS.has(tag)),
  };
}

export const DEFAULT_TOOLS: ToolDef[] = [
  tool(
    "read_file",
    ["read"],
    "Read a span of a file. Prefer the line range from the code graph over the whole file. Use this before proposing an edit so the change matches the current source. Do not read a file the graph did not mention unless the task names it.",
    { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } }, required: ["path"] },
  ),
  tool(
    "graph_query",
    ["graph"],
    "Look up a symbol in the local code graph. Returns the file, the line span, the callers, and the callees. Use this instead of searching the repository with broad reads. The graph is local and already built.",
    { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  ),
  tool(
    "search_repo",
    ["search"],
    "Search file names and symbol names in the indexed graph. Use this when the task names a feature but not a function. Results are paths and signatures, not file bodies.",
    { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  ),
  tool(
    "apply_edit",
    ["edit"],
    "Replace a line span in one file. This writes to disk. The extension stops the call until the user approves it. Send the full replacement for that span, not a diff format the editor cannot apply.",
    { type: "object", properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" }, text: { type: "string" } }, required: ["path", "text"] },
  ),
  tool(
    "run_shell",
    ["shell"],
    "Run a shell command in the workspace. Tests, builds, and linters use this. The extension stops the call until the user approves it. Do not use the shell to read files the graph can answer.",
    { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  ),
  tool(
    "git_status",
    ["git"],
    "Show the working tree status. This is a git operation. The extension stops the call until the user approves it, even though it does not change files.",
    { type: "object", properties: {} },
  ),
  tool(
    "git_commit",
    ["git"],
    "Create a git commit with the message you provide. This is a git operation. The extension stops the call until the user approves it. Do not push.",
    { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  ),
  tool(
    "web_search",
    ["web"],
    "Search the public web through Tavily. Use this for library documentation that is not in the repository. Do not send repository source in the query.",
    { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  ),
];

function shorten(description: string): string {
  const sentence = description.split(/(?<=\.)\s/)[0] ?? description;
  if (sentence.length <= 140) {
    return sentence;
  }
  return sentence.slice(0, 137) + "...";
}

const TAG_BY_NAME: Record<string, ToolTag> = {
  read: "read",
  readfile: "read",
  viewfile: "read",
  geterrors: "read",
  listdir: "search",
  glob: "search",
  grep: "search",
  grepsearch: "search",
  filesearch: "search",
  semanticsearch: "search",
  codebasesearch: "search",
  searchrepo: "search",
  search: "search",
  graphquery: "graph",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  strreplace: "edit",
  searchreplace: "edit",
  delete: "edit",
  deletefile: "edit",
  applyedit: "edit",
  applypatch: "edit",
  createfile: "edit",
  inserteditintofile: "edit",
  replacestringinfile: "edit",
  notebookedit: "edit",
  editnotebook: "edit",
  bash: "shell",
  shell: "shell",
  runshell: "shell",
  runterminalcmd: "shell",
  runinterminal: "shell",
  getterminaloutput: "shell",
  gitstatus: "git",
  gitcommit: "git",
  gitdiff: "git",
  getchangedfiles: "git",
  websearch: "web",
  webfetch: "web",
  todowrite: "meta",
  task: "meta",
  switchmode: "meta",
  enterplanmode: "meta",
  exitplanmode: "meta",
  askquestion: "extra",
  askuserquestion: "extra",
  generateimage: "extra",
  skill: "extra",
  fetchmcpresource: "extra",
  callmcptool: "extra",
};

export function inferToolTags(name: string): ToolTag[] {
  const key = name.toLowerCase().replace(/[_-]/g, "");
  const tag = TAG_BY_NAME[key];
  return tag ? [tag] : [];
}

export function defineExternalTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
): ToolDef {
  const tags = inferToolTags(name);
  return {
    name,
    description,
    parameters,
    tags,
    requiresApproval: tags.some((tag) => APPROVAL_TAGS.has(tag)),
  };
}

function withTags(tool: ToolDef): ToolDef {
  if (tool.tags.length > 0) {
    return tool;
  }
  const tags = inferToolTags(tool.name);
  return {
    ...tool,
    tags,
    requiresApproval: tool.requiresApproval || tags.some((tag) => APPROVAL_TAGS.has(tag)),
  };
}

function wantedTags(task: TaskKind, userText: string): Set<ToolTag> {
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

const DROP_HEADING =
  /^(examples?|few[- ]shot(?: examples)?|style guide|tone and style|communication(?: style)?|citing code|code citations|persona|identity|background|changelog|using your tools|how to use tools|tool use|tool usage|available tools|response style|personality|making code changes|formatting|markdown|citation|attached files|open files|codebase|file contents|relevant files)\b/i;

const MAX_HARNESS_TOKENS = 420;
const ROLE =
  "You are a coding agent in the editor. Follow the repository's existing style. Make the smallest change that satisfies the task.";
export const TOOL_PROTOCOL =
  "Use only the tools listed for this turn. Read a span before you edit it. Emit a tool call for each action. Do not invent tool results.";
const CONSTRAINT = /\b(must|never|do not|don't|cannot|can't|approval|forbidden|secret)\b/i;
const DIALOGUE = /^(user|agent|human|assistant)\s*:/i;
const RULE_HEADING = /^(rules|user rules|constraints|safety)\b/i;

const SCHEMA_DROP = new Set(["description", "title", "examples", "example", "default", "$schema", "additionalProperties"]);

function dropLongFences(text: string, maxLines: number): string {
  return text.replace(/```[\s\S]*?```/g, (fence) => (fence.split("\n").length > maxLines ? "" : fence));
}

function slimSchema(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SCHEMA_DROP.has(key)) {
      continue;
    }
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      const props: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(child as Record<string, unknown>)) {
        const slim = slimSchema(schema);
        if (slim) {
          props[name] = slim;
        }
      }
      out.properties = props;
      continue;
    }
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const slim = slimSchema(child);
      if (slim) {
        out[key] = slim;
      }
      continue;
    }
    out[key] = child;
  }
  return out;
}

function minimumHarness(stripped: string): string {
  const kept: string[] = [];
  let inRules = false;
  for (const raw of stripped.split("\n")) {
    const line = raw.trim();
    if (!line || DIALOGUE.test(line) || line.startsWith("```")) {
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      inRules = RULE_HEADING.test(heading[2].trim());
      continue;
    }
    if (line.length > 220 || (!inRules && !CONSTRAINT.test(line))) {
      continue;
    }
    if (!kept.includes(line)) {
      kept.push(line);
    }
    if (kept.length >= 16) {
      break;
    }
  }
  return [ROLE, ...kept].join("\n");
}

export function distillHarness(system: string): string {
  const compact = dropLongFences(stripSections(system), 20).replace(/\n{3,}/g, "\n\n").trim();
  let body = countTokens(compact) <= MAX_HARNESS_TOKENS ? compact : minimumHarness(compact);
  if (!body.includes("Use only the tools listed")) {
    body = `${body}\n\n${TOOL_PROTOCOL}`;
  }
  if (!body.includes(CORE_CHECK)) {
    body = `${body}\n\n${PROTECTED_CORE}`;
  }
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function stripExampleBlocks(system: string): string {
  const parts = system.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        return part;
      }
      return part
        .replace(/<examples\b[^>]*>[\s\S]*?<\/examples>/gi, "")
        .replace(/<example\b[^>]*>[\s\S]*?<\/example>/gi, "")
        .replace(/<good[_-]?example\b[^>]*>[\s\S]*?<\/good[_-]?example>/gi, "")
        .replace(/<bad[_-]?example\b[^>]*>[\s\S]*?<\/bad[_-]?example>/gi, "");
    })
    .join("");
}

export function stripSections(system: string): string {
  const lines = stripExampleBlocks(system).replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let dropping = false;
  let fence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      fence = !fence;
      if (!dropping) {
        kept.push(line);
      }
      continue;
    }
    if (!fence) {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        dropping = DROP_HEADING.test(heading[2].trim());
        if (dropping) {
          continue;
        }
      }
    }
    if (!dropping) {
      kept.push(line);
    }
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function stripHarness(
  systemPrompt: string,
  tools: ToolDef[],
  userText: string,
): { systemPrompt: string; tools: ToolDef[]; task: TaskKind; dropped: string[] } {
  const task = classifyTask(userText);
  const tagged = tools.map(withTags);
  const allow = wantedTags(task, userText);
  const hasGitWrite = tagged.some((tool) => tool.tags.includes("git") && /commit|branch|merge|rebase/i.test(tool.name));
  if (allow.has("git") && !hasGitWrite) {
    allow.add("shell");
  }
  const kept = tagged
    .filter((item) => item.tags.some((tag) => allow.has(tag)) || mentionsTool(userText, item.name))
    .map((item) => ({
      ...item,
      description: shorten(item.description),
      parameters: item.parameters ? slimSchema(item.parameters) : item.parameters,
    }));
  const system = distillHarness(systemPrompt);
  const dropped = tagged.filter((item) => !kept.some((next) => next.name === item.name)).map((item) => item.name);
  return { systemPrompt: system.trim(), tools: kept, task, dropped };
}

const APPROVAL_TOOLS = new Set(DEFAULT_TOOLS.filter((item) => item.requiresApproval).map((item) => item.name));

export function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

export function reviewToolCall(name: string, approved: boolean): { proceed: boolean; reason: string } {
  const needsApproval = APPROVAL_TOOLS.has(name) || inferToolTags(name).some((tag) => APPROVAL_TAGS.has(tag));
  if (!needsApproval) {
    return { proceed: true, reason: "Read operations run without a prompt." };
  }
  if (approved) {
    return { proceed: true, reason: "The user approved this call." };
  }
  return { proceed: false, reason: `${name} needs explicit approval before it runs.` };
}
