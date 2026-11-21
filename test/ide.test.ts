import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import test from "node:test";
import { clearEndpoint, cursorHookSync, decideIdeHook, detectIdeHost, writeEndpoint } from "../src/core/ideClient";
import { removeCursorHook } from "../src/installHooks";
import { startProxy } from "../src/proxyServer";

test("an IDE prompt is answered by the extension and is not forwarded upstream", async () => {
  const upstreamHits: string[] = [];
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const address = upstream.address();
  const upstreamPort = address && typeof address === "object" ? address.port : 0;
  const seen: string[] = [];
  const proxy = await startProxy({
    port: 0,
    upstream: `http://127.0.0.1:${upstreamPort}`,
    ideToken: "secret",
    onIdeTurn: async (input) => {
      seen.push(input.prompt);
      return { content: "Updated the guest checkout.", model: "openai/gpt-4o-mini", notice: null };
    },
  });
  const file = path.join(os.tmpdir(), `tokenpilot-endpoint-${proxy.port}.json`);
  writeEndpoint(file, { port: proxy.port, token: "secret" });
  try {
    const decision = await decideIdeHook({
      endpointFile: file,
      prompt: "Please update checkout for guests.",
      conversationId: "chat-9",
    });
    assert.deepEqual(decision, { continue: false, user_message: "Updated the guest checkout." });
    assert.deepEqual(seen, ["Please update checkout for guests."]);
    assert.deepEqual(upstreamHits, []);

    const rejected = await fetch(`http://127.0.0.1:${proxy.port}/tokenpilot/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer other" },
      body: JSON.stringify({ prompt: "nope" }),
    });
    assert.equal(rejected.status, 404);
    assert.deepEqual(seen, ["Please update checkout for guests."]);
    assert.deepEqual(upstreamHits, []);
  } finally {
    fs.rmSync(file, { force: true });
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("Cursor and VS Code are told apart, and only Cursor may claim the hook", () => {
  assert.equal(detectIdeHost("Cursor", "cursor"), "cursor");
  assert.equal(detectIdeHost("Visual Studio Code", "vscode"), "vscode");
  assert.equal(detectIdeHost("Visual Studio Code - Insiders", "vscode-insiders"), "vscode");
  assert.equal(detectIdeHost("Windsurf", "windsurf"), "other");

  assert.equal(cursorHookSync("cursor", true, false), "install");
  assert.equal(cursorHookSync("cursor", false, false), "remove");
  assert.equal(cursorHookSync("cursor", false, true), "keep");
  assert.equal(cursorHookSync("vscode", true, false), "remove");
  assert.equal(cursorHookSync("vscode", true, true), "keep");
});

test("a VS Code endpoint does not capture a Cursor prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-ide-"));
  const vscodeFile = path.join(dir, "endpoint-vscode.json");
  const cursorFile = path.join(dir, "endpoint-cursor.json");
  writeEndpoint(vscodeFile, { port: 9, token: "secret" });
  try {
    const decision = await decideIdeHook({
      endpointFile: cursorFile,
      prompt: "Rename the header.",
      conversationId: "chat-11",
    });
    assert.deepEqual(decision, { continue: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing an endpoint leaves another IDE's record in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-endpoint-"));
  const file = path.join(dir, "endpoint-cursor.json");
  writeEndpoint(file, { port: 8787, token: "cursor-token" });
  try {
    assert.equal(clearEndpoint(file, "vscode-token"), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(clearEndpoint(file, "cursor-token"), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removing the Cursor hook keeps unrelated hooks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-hooks-"));
  const hooksPath = path.join(dir, "hooks.json");
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "echo keep" }, { command: '"node" "/ext/dist/turn-hook.js"', timeout: 90 }],
        stop: [{ command: "node /ext/dist/turn-hook.js" }],
      },
    }),
  );
  try {
    removeCursorHook(hooksPath);
    const saved = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      hooks: { beforeSubmitPrompt?: Array<{ command: string }>; stop?: unknown };
    };
    assert.deepEqual(saved.hooks.beforeSubmitPrompt, [{ command: "echo keep" }]);
    assert.equal(saved.hooks.stop, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing extension lets the IDE prompt continue", async () => {
  const missing = path.join(os.tmpdir(), `tokenpilot-missing-${process.pid}.json`);
  const decision = await decideIdeHook({
    endpointFile: missing,
    prompt: "Rename the header.",
    conversationId: "chat-10",
  });
  assert.deepEqual(decision, { continue: true });
});
