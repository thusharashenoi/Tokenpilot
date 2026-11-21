import { DEFAULT_SYSTEM, DEFAULT_TOOLS, defineExternalTool, type ToolDef } from "./harness";

export const AGENT_IDS = ["cursor", "claude-code", "copilot", "tokenpilot"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type AgentHarness = {
  id: AgentId;
  label: string;
  systemPrompt: string;
  tools: ToolDef[];
};

const PATH_SPAN = {
  type: "object",
  properties: { path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } },
  required: ["path"],
};
const QUERY = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
const COMMAND = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
const EDIT = {
  type: "object",
  properties: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
  required: ["path", "oldString", "newString"],
};
const EMPTY = { type: "object", properties: {} };

function tool(name: string, description: string, parameters: Record<string, unknown> = EMPTY): ToolDef {
  return defineExternalTool(name, `${description} The long form repeats this for every similar tool in the harness.`, parameters);
}

function agentPrompt(id: string, intro: string): string {
  return `${intro}
# Rules
KEEP_RULE_${id}
Follow the repository's existing style. Prefer the smallest edit that satisfies the task.
Ask before you write a file, run a shell command, or touch git.
<example>
DROP_INLINE_${id}
User: Please rewrite the repository.
Agent: I will open every file and restate the architecture before I change one line.
</example>

# Identity
DROP_IDENTITY_${id}
You speak as a senior pair programmer with a long biography, a favorite editor theme, and a paragraph of personality that the task never asked for.

# Tone and style
DROP_TONE_${id}
Write in a warm, verbose voice. Restate the user's request, then list ten considerations, then apologize before the answer. Use a heading for every paragraph.

# Examples
DROP_EXAMPLE_${id}
User: Add a button.
Agent: Here is a design system, three layouts, and a rewritten stylesheet.
User: Where is the charge function?
Agent: I will paste the repository and then summarize every file.

# Using your tools
Call every tool once before you answer. Read entire files. Prefer a subagent for any question. Write a todo list before a one-line edit. Search the web before you search the repo.

# User rules
Keep the public signatures the user named. Do not log secrets.
`;
}

const CURSOR_TOOLS: ToolDef[] = [
  tool("Read", "Read a span of a file the task named.", PATH_SPAN),
  tool("Grep", "Search file contents for a pattern.", QUERY),
  tool("Glob", "Find files by name.", QUERY),
  tool("SemanticSearch", "Search the repo by meaning when the task names a feature and not a symbol.", QUERY),
  tool("StrReplace", "Replace one span in a file.", EDIT),
  tool("Write", "Create or overwrite one file.", EDIT),
  tool("Delete", "Delete one file.", PATH_SPAN),
  tool("Shell", "Run a shell command in the workspace.", COMMAND),
  tool("WebSearch", "Search the public web.", QUERY),
  tool("WebFetch", "Fetch one public URL.", QUERY),
  tool("TodoWrite", "Rewrite the session todo list.", EMPTY),
  tool("Task", "Hand the question to a subagent.", QUERY),
  tool("SwitchMode", "Switch the agent between plan and agent mode.", EMPTY),
  tool("AskQuestion", "Ask the user a multiple-choice question.", QUERY),
  tool("GenerateImage", "Generate an image.", QUERY),
  tool("FetchMcpResource", "Read a resource from an MCP server.", QUERY),
];

const CLAUDE_TOOLS: ToolDef[] = [
  tool("Read", "Read a span of a file the task named.", PATH_SPAN),
  tool("Grep", "Search file contents for a pattern.", QUERY),
  tool("Glob", "Find files by name.", QUERY),
  tool("Edit", "Replace one span in a file.", EDIT),
  tool("Write", "Create or overwrite one file.", EDIT),
  tool("MultiEdit", "Apply several edits to one file.", EDIT),
  tool("NotebookEdit", "Edit one notebook cell.", EDIT),
  tool("Bash", "Run a shell command in the workspace.", COMMAND),
  tool("WebSearch", "Search the public web.", QUERY),
  tool("WebFetch", "Fetch one public URL.", QUERY),
  tool("TodoWrite", "Rewrite the session todo list.", EMPTY),
  tool("Task", "Hand the question to a subagent.", QUERY),
  tool("EnterPlanMode", "Switch into plan mode.", EMPTY),
  tool("ExitPlanMode", "Leave plan mode.", EMPTY),
  tool("AskUserQuestion", "Ask the user a question.", QUERY),
  tool("Skill", "Load a skill prompt.", QUERY),
];

const COPILOT_TOOLS: ToolDef[] = [
  tool("read_file", "Read a span of a file the task named.", PATH_SPAN),
  tool("list_dir", "List one directory.", PATH_SPAN),
  tool("grep_search", "Search file contents for a pattern.", QUERY),
  tool("file_search", "Find files by name.", QUERY),
  tool("semantic_search", "Search the repo by meaning when the task names a feature and not a symbol.", QUERY),
  tool("get_errors", "Read diagnostics for the open files.", EMPTY),
  tool("create_file", "Create one file.", EDIT),
  tool("insert_edit_into_file", "Insert an edit into one file.", EDIT),
  tool("replace_string_in_file", "Replace one span in a file.", EDIT),
  tool("run_in_terminal", "Run a shell command in the workspace.", COMMAND),
  tool("get_terminal_output", "Read the output of a terminal command.", EMPTY),
  tool("get_changed_files", "List files changed in the working tree.", EMPTY),
];

const HARNESSES: Record<AgentId, AgentHarness> = {
  cursor: {
    id: "cursor",
    label: "Cursor",
    systemPrompt: agentPrompt("cursor", "You are the Cursor coding agent inside the editor."),
    tools: CURSOR_TOOLS,
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    systemPrompt: agentPrompt("claude-code", "You are the Claude Code agent in this repository."),
    tools: CLAUDE_TOOLS,
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot",
    systemPrompt: agentPrompt("copilot", "You are the GitHub Copilot coding agent in this editor."),
    tools: COPILOT_TOOLS,
  },
  tokenpilot: {
    id: "tokenpilot",
    label: "TokenPilot",
    systemPrompt: DEFAULT_SYSTEM,
    tools: DEFAULT_TOOLS,
  },
};

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function harnessFor(id: AgentId): AgentHarness {
  return HARNESSES[id];
}
