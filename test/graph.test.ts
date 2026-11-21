import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { GraphIndex } from "../src/core/graph";

const root = path.join(process.cwd(), "sample-repo");

test("the graph connects callers and withholds file bodies", () => {
  const index = new GraphIndex();
  const validation = index.load(root);
  assert.equal(validation.ok, true, validation.issues.join("\n"));
  const nameOf = (id: string) => index.graph.nodes.find((node) => node.id === id)?.name;
  const calls = (from: string, to: string) =>
    index.graph.edges.some((edge) => edge.relation === "calls" && nameOf(edge.from) === from && nameOf(edge.to) === to);
  assert.equal(calls("checkout", "charge"), true);
  assert.equal(calls("submit", "checkout"), true);
  assert.equal(calls("charge", "writeLedger"), true);

  const hit = index.queryText("who calls charge");
  const names = hit.symbols.map((symbol) => symbol.name);
  assert.ok(names.includes("charge"));
  assert.ok(names.includes("checkout"));
  assert.ok(names.includes("writeLedger"));
  assert.ok(hit.packTokens < hit.fullFileTokens);
  assert.equal(hit.pack.includes("918273"), false);
  assert.equal(hit.pack.includes("771100"), false);
  assert.match(hit.pack, /calledBy: checkout/);
});

test("a broken import fails validation", () => {
  const index = new GraphIndex();
  index.load(root);
  const chargePath = path.join(root, "src", "charge.ts");
  const validation = index.setFile(
    chargePath,
    'import { missing } from "./missing";\nexport function charge() { return 1; }\n',
  );
  assert.equal(validation.ok, false);
  assert.match(validation.issues.join("\n"), /imports \.\/missing/);
});
