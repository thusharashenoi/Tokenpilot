import fs from "fs";
import path from "path";
import ts from "typescript";
import { countTokens } from "./tokens";

export type SymbolKind = "function" | "class" | "method" | "type" | "interface" | "file";
export type Relation = "calls" | "imports" | "extends" | "member";

export type SymbolNode = {
  id: string;
  name: string;
  owner?: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
};

export type GraphEdge = {
  from: string;
  to: string;
  relation: Relation;
};

export type CodeGraph = {
  root: string;
  nodes: SymbolNode[];
  edges: GraphEdge[];
  files: number;
  truncated: boolean;
  builtAt: string;
};

export type GraphValidation = {
  ok: boolean;
  issues: string[];
};

export type GraphStats = {
  files: number;
  symbols: number;
  edges: number;
  truncated: boolean;
  ok: boolean;
  issues: string[];
  root: string;
  builtAt: string;
};

export type GraphSymbol = Pick<SymbolNode, "name" | "owner" | "kind" | "file" | "startLine" | "endLine" | "signature">;

export type GraphHit = {
  symbols: GraphSymbol[];
  pack: string;
  packTokens: number;
  fullFileTokens: number;
  files: string[];
};

type RawCall = { from: string; name: string };
type RawImport = { fromFile: string; spec: string; names: string[] };
type RawNameEdge = { from: string; name: string };
type RawMember = { from: string; to: string };
type Frame = { id: string; kind: SymbolKind; name: string };

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-test", ".git", "out", "coverage", ".vscode"]);
const MAX_FILES = 400;
const SKIP_ROOTS = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "Promise",
  "document",
  "window",
  "process",
  "Buffer",
  "vscode",
  "ts",
]);
const BLOCK = new Set([
  "add", "get", "set", "id", "map", "name", "type", "log", "error", "data", "value",
  "item", "items", "line", "lines", "file", "read", "write", "open", "run", "call",
  "update", "change", "make", "create", "new", "return", "function", "class", "const",
  "let", "var", "import", "export", "from", "true", "false", "null", "undefined",
  "string", "number", "boolean", "object", "array", "promise", "async", "await", "if",
  "else", "for", "while", "try", "catch", "throw", "this", "super", "public", "private",
  "static", "default", "extends", "implements", "interface", "user", "users", "guest",
  "flow", "code", "task", "model", "token", "tokens", "path", "test", "tests", "clear",
  "find", "push", "length", "brand", "price", "qty", "sku", "calls", "called",
  "calling", "keep", "look", "pay", "help", "current", "payload", "account",
  "public", "signature", "never",
]);

const EMPTY_HIT: GraphHit = { symbols: [], pack: "", packTokens: 0, fullFileTokens: 0, files: [] };

function emptyGraph(): CodeGraph {
  return { root: "", nodes: [], edges: [], files: 0, truncated: false, builtAt: "" };
}

export class GraphIndex {
  root = "";
  graph: CodeGraph = emptyGraph();
  validation: GraphValidation = { ok: true, issues: [] };
  private sources = new Map<string, string>();

  load(root: string): GraphValidation {
    this.root = path.resolve(root);
    this.sources.clear();
    if (!fs.existsSync(this.root)) {
      this.graph = emptyGraph();
      this.validation = { ok: false, issues: ["Workspace folder is missing."] };
      return this.validation;
    }
    const found: string[] = [];
    walk(this.root, found, 0);
    found.sort();
    const truncated = found.length > MAX_FILES;
    const files = truncated ? found.slice(0, MAX_FILES) : found;
    const readIssues: string[] = [];
    for (const file of files) {
      try {
        this.sources.set(file, fs.readFileSync(file, "utf8"));
      } catch (error) {
        readIssues.push(`${relPosix(this.root, file)}: ${error instanceof Error ? error.message : "unreadable"}`);
      }
    }
    this.rebuild(truncated);
    if (readIssues.length > 0) {
      this.validation = { ok: false, issues: [...readIssues, ...this.validation.issues] };
    }
    return this.validation;
  }

  setFile(absPath: string, text: string): GraphValidation {
    if (!this.root) {
      return this.validation;
    }
    const file = path.resolve(absPath);
    if (file !== this.root && !file.startsWith(this.root + path.sep)) {
      return this.validation;
    }
    this.sources.set(file, text);
    return this.rebuild(this.graph.truncated);
  }

  stats(): GraphStats {
    return {
      files: this.graph.files,
      symbols: this.graph.nodes.filter((node) => node.kind !== "file").length,
      edges: this.graph.edges.length,
      truncated: this.graph.truncated,
      ok: this.validation.ok,
      issues: this.validation.issues,
      root: this.graph.root,
      builtAt: this.graph.builtAt,
    };
  }

  queryText(text: string): GraphHit {
    return this.packFromIds(matchNames(this.graph.nodes, text));
  }

  querySymbol(name: string): GraphHit {
    const trimmed = name.trim();
    if (!trimmed) {
      return EMPTY_HIT;
    }
    const symbols = this.graph.nodes.filter((node) => node.kind !== "file");
    const exact = symbols.filter((node) => node.name === trimmed);
    const pool = exact.length > 0 ? exact : symbols.filter((node) => node.name.toLowerCase() === trimmed.toLowerCase());
    return this.packFromIds(pool.map((node) => node.id));
  }

  private rebuild(truncated: boolean): GraphValidation {
    const issues: string[] = [];
    if (truncated) {
      issues.push(`Indexed the first ${MAX_FILES} source files.`);
    }
    const nodes: SymbolNode[] = [];
    const rawCalls: RawCall[] = [];
    const rawImports: RawImport[] = [];
    const rawExtends: RawNameEdge[] = [];
    const rawMembers: RawMember[] = [];
    for (const [file, text] of this.sources) {
      try {
        parseFile(this.root, file, text, nodes, rawCalls, rawImports, rawExtends, rawMembers);
      } catch (error) {
        issues.push(`${relPosix(this.root, file)}: ${error instanceof Error ? error.message : "parse failed"}`);
      }
    }
    const edges = resolve(this.root, new Set(this.sources.keys()), nodes, rawCalls, rawImports, rawExtends, rawMembers, issues);
    this.graph = {
      root: this.root,
      nodes,
      edges,
      files: this.sources.size,
      truncated,
      builtAt: new Date().toISOString(),
    };
    const linkIssues = issues.filter((issue) => !issue.startsWith("Indexed the first"));
    this.validation = { ok: linkIssues.length === 0, issues };
    return this.validation;
  }

  private packFromIds(seedIds: string[]): GraphHit {
    if (seedIds.length === 0) {
      return EMPTY_HIT;
    }
    const seeds = new Set(seedIds.slice(0, 32));
    const ids = new Set(seeds);
    for (const edge of this.graph.edges) {
      if (seeds.has(edge.from) || seeds.has(edge.to)) {
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    const order = new Map(seedIds.map((id, index) => [id, index]));
    const symbols = this.graph.nodes
      .filter((node) => ids.has(node.id) && node.kind !== "file")
      .sort((a, b) => (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100) || a.file.localeCompare(b.file) || a.startLine - b.startLine)
      .slice(0, 24);
    const byId = new Map(this.graph.nodes.map((node) => [node.id, node]));
    const lines = ["GRAPH"];
    for (const symbol of symbols) {
      lines.push(`${labelOf(symbol)} ${shortKind(symbol.kind)} ${symbol.file}:${symbol.startLine}-${symbol.endLine}`);
      const calls = labels(this.graph.edges, byId, (edge) =>
        edge.from === symbol.id && edge.relation === "calls" ? edge.to : undefined,
      );
      const calledBy = labels(this.graph.edges, byId, (edge) =>
        edge.to === symbol.id && edge.relation === "calls" ? edge.from : undefined,
      );
      const importedBy = this.graph.edges
        .filter((edge) => edge.to === symbol.id && edge.relation === "imports")
        .map((edge) => byId.get(edge.from)?.file)
        .filter((file): file is string => Boolean(file));
      const bases = labels(this.graph.edges, byId, (edge) =>
        edge.from === symbol.id && edge.relation === "extends" ? edge.to : undefined,
      );
      if (calls.length > 0) {
        lines.push(`  calls: ${calls.slice(0, 8).join(", ")}`);
      }
      if (calledBy.length > 0) {
        lines.push(`  calledBy: ${calledBy.slice(0, 8).join(", ")}`);
      }
      if (bases.length > 0) {
        lines.push(`  extends: ${bases.join(", ")}`);
      }
      if (importedBy.length > 0) {
        lines.push(`  importedBy: ${[...new Set(importedBy)].slice(0, 8).join(", ")}`);
      }
    }
    const pack = lines.join("\n");
    const files = [...new Set(symbols.map((symbol) => symbol.file))];
    let fullFileTokens = 0;
    for (const file of files) {
      fullFileTokens += countTokens(this.sources.get(path.resolve(this.root, file)) ?? "");
    }
    return {
      symbols: symbols.map(({ name, owner, kind, file, startLine, endLine, signature }) => ({
        name,
        owner,
        kind,
        file,
        startLine,
        endLine,
        signature,
      })),
      pack,
      packTokens: countTokens(pack),
      fullFileTokens,
      files,
    };
  }
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 12) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile() && /\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path.resolve(full));
    }
  }
}

function parseFile(
  root: string,
  file: string,
  text: string,
  nodes: SymbolNode[],
  rawCalls: RawCall[],
  rawImports: RawImport[],
  rawExtends: RawNameEdge[],
  rawMembers: RawMember[],
): void {
  const relative = relPosix(root, file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const fileId = `file:${relative}`;
  nodes.push({
    id: fileId,
    name: path.posix.basename(relative),
    kind: "file",
    file: relative,
    startLine: 1,
    endLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
    signature: relative,
  });
  const stack: Frame[] = [];
  const visit = (node: ts.Node): void => {
    let pushed = false;
    if (ts.isFunctionDeclaration(node) && node.name) {
      stack.push({ id: addSymbol(nodes, source, relative, node.name.text, "function", node), kind: "function", name: node.name.text });
      pushed = true;
    } else if (ts.isClassDeclaration(node) && node.name) {
      const id = addSymbol(nodes, source, relative, node.name.text, "class", node);
      stack.push({ id, kind: "class", name: node.name.text });
      pushed = true;
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
          continue;
        }
        for (const typeNode of clause.types) {
          if (ts.isIdentifier(typeNode.expression)) {
            rawExtends.push({ from: id, name: typeNode.expression.text });
          }
        }
      }
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const owner = [...stack].reverse().find((frame) => frame.kind === "class");
      const id = addSymbol(nodes, source, relative, node.name.text, "method", node, owner?.name);
      if (owner) {
        rawMembers.push({ from: owner.id, to: id });
      }
      stack.push({ id, kind: "method", name: node.name.text });
      pushed = true;
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(nodes, source, relative, node.name.text, "interface", node);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(nodes, source, relative, node.name.text, "type", node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      stack.push({
        id: addSymbol(nodes, source, relative, node.name.text, "function", node),
        kind: "function",
        name: node.name.text,
      });
      pushed = true;
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      rawImports.push({ fromFile: file, spec: node.moduleSpecifier.text, names: importNames(node) });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      rawImports.push({ fromFile: file, spec: node.moduleSpecifier.text, names: exportNames(node) });
    }
    if (ts.isCallExpression(node)) {
      noteCall(node, file, fileId, stack, rawCalls, rawImports);
    } else if (ts.isNewExpression(node)) {
      const ref = calleeRef(node.expression);
      if (ref && !SKIP_ROOTS.has(ref.root ?? "")) {
        rawCalls.push({ from: stack[stack.length - 1]?.id ?? fileId, name: ref.name });
      }
    }

    ts.forEachChild(node, visit);
    if (pushed) {
      stack.pop();
    }
  };
  visit(source);
}

function noteCall(
  node: ts.CallExpression,
  file: string,
  fileId: string,
  stack: Frame[],
  rawCalls: RawCall[],
  rawImports: RawImport[],
): void {
  const argument = node.arguments[0];
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument && ts.isStringLiteral(argument)) {
    rawImports.push({ fromFile: file, spec: argument.text, names: [] });
    return;
  }
  const ref = calleeRef(node.expression);
  if (!ref || SKIP_ROOTS.has(ref.root ?? "")) {
    return;
  }
  if (ref.name === "require" && !ref.root && argument && ts.isStringLiteral(argument)) {
    rawImports.push({ fromFile: file, spec: argument.text, names: [] });
    return;
  }
  rawCalls.push({ from: stack[stack.length - 1]?.id ?? fileId, name: ref.name });
}

function importNames(node: ts.ImportDeclaration): string[] {
  const names: string[] = [];
  const clause = node.importClause;
  if (clause?.name) {
    names.push(clause.name.text);
  }
  if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      names.push(element.name.text);
    }
  }
  return names;
}

function exportNames(node: ts.ExportDeclaration): string[] {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) {
    return [];
  }
  return node.exportClause.elements.map((element) => element.name.text);
}

function calleeRef(expr: ts.Expression): { name: string; root?: string } | null {
  if (ts.isIdentifier(expr)) {
    return { name: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return {
      name: expr.name.text,
      root: ts.isIdentifier(expr.expression) ? expr.expression.text : undefined,
    };
  }
  return null;
}

function addSymbol(
  nodes: SymbolNode[],
  source: ts.SourceFile,
  file: string,
  name: string,
  kind: SymbolKind,
  node: ts.Node,
  owner?: string,
): string {
  const start = node.getStart(source);
  const startLine = source.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const lineStarts = source.getLineStarts();
  const lineEnd = startLine < lineStarts.length ? lineStarts[startLine] : source.end;
  const signature = source.text.slice(lineStarts[startLine - 1] ?? start, lineEnd).trim().slice(0, 180);
  const id = `${file}:${startLine}:${name}`;
  nodes.push({ id, name, owner, kind, file, startLine, endLine, signature });
  return id;
}

function resolve(
  root: string,
  known: Set<string>,
  nodes: SymbolNode[],
  rawCalls: RawCall[],
  rawImports: RawImport[],
  rawExtends: RawNameEdge[],
  rawMembers: RawMember[],
  issues: string[],
): GraphEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byName = new Map<string, SymbolNode[]>();
  for (const node of nodes) {
    if (node.kind === "file") {
      continue;
    }
    const list = byName.get(node.name) ?? [];
    list.push(node);
    byName.set(node.name, list);
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const link = (from: string, to: string, relation: Relation) => {
    const key = `${from}|${relation}|${to}`;
    if (from === to || seen.has(key)) {
      return;
    }
    seen.add(key);
    edges.push({ from, to, relation });
  };

  for (const member of rawMembers) {
    link(member.from, member.to, "member");
  }
  for (const call of rawCalls) {
    const candidates = byName.get(call.name) ?? [];
    if (candidates.length === 0) {
      continue;
    }
    const fromFile = byId.get(call.from)?.file;
    const same = candidates.filter((candidate) => candidate.file === fromFile);
    if (same.length > 0) {
      for (const target of same) {
        link(call.from, target.id, "calls");
      }
    } else if (candidates.length === 1) {
      link(call.from, candidates[0].id, "calls");
    } else {
      issues.push(`${fromFile ?? call.from}: call "${call.name}" matches ${candidates.length} symbols`);
    }
  }
  for (const item of rawExtends) {
    const classes = (byName.get(item.name) ?? []).filter((node) => node.kind === "class" || node.kind === "interface");
    if (classes.length === 1) {
      link(item.from, classes[0].id, "extends");
    }
  }
  for (const item of rawImports) {
    if (!item.spec.startsWith(".")) {
      continue;
    }
    const fromRel = relPosix(root, item.fromFile);
    const resolved = resolveImport(item.fromFile, item.spec, known);
    if (!resolved) {
      issues.push(`${fromRel}: imports ${item.spec}, and that file is not in the graph`);
      continue;
    }
    const toRel = relPosix(root, resolved);
    link(`file:${fromRel}`, `file:${toRel}`, "imports");
    for (const name of item.names) {
      for (const target of (byName.get(name) ?? []).filter((node) => node.file === toRel)) {
        link(`file:${fromRel}`, target.id, "imports");
      }
    }
  }
  return edges;
}

function resolveImport(fromFile: string, spec: string, known: Set<string>): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (known.has(resolved)) {
      return resolved;
    }
  }
  return null;
}

function matchNames(nodes: SymbolNode[], text: string): string[] {
  const symbols = nodes.filter((node) => node.kind !== "file" && node.name.length >= 3 && !BLOCK.has(node.name));
  const names = [...new Set(symbols.map((symbol) => symbol.name))].sort((a, b) => b.length - a.length);
  const hits: string[] = [];
  for (const name of names) {
    const spellings = new Set(symbols.filter((symbol) => symbol.name.toLowerCase() === name.toLowerCase()).map((symbol) => symbol.name));
    const flags = spellings.size === 1 ? "i" : "";
    if (new RegExp(`\\b${escapeReg(name)}\\b`, flags).test(text)) {
      for (const spelling of spellings) {
        if (!hits.includes(spelling)) {
          hits.push(spelling);
        }
      }
    }
    if (hits.length >= 8) {
      break;
    }
  }
  const chosen = new Set(hits.slice(0, 8));
  return symbols.filter((symbol) => chosen.has(symbol.name)).map((symbol) => symbol.id);
}

function labels(
  edges: GraphEdge[],
  byId: Map<string, SymbolNode>,
  pick: (edge: GraphEdge) => string | undefined,
): string[] {
  const names: string[] = [];
  for (const edge of edges) {
    const id = pick(edge);
    if (!id) {
      continue;
    }
    const symbol = byId.get(id);
    if (!symbol || symbol.kind === "file") {
      continue;
    }
    const label = labelOf(symbol);
    if (!names.includes(label)) {
      names.push(label);
    }
  }
  return names;
}

function labelOf(node: SymbolNode): string {
  return node.owner ? `${node.owner}.${node.name}` : node.name;
}

function shortKind(kind: SymbolKind): string {
  if (kind === "function") {
    return "fn";
  }
  if (kind === "interface") {
    return "iface";
  }
  return kind;
}

function relPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (file.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
