import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import test from "node:test";
import { decideIdeHook, writeEndpoint } from "../src/core/ideClient";
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

test("a missing extension lets the IDE prompt continue", async () => {
  const missing = path.join(os.tmpdir(), `tokenpilot-missing-${process.pid}.json`);
  const decision = await decideIdeHook({
    endpointFile: missing,
    prompt: "Rename the header.",
    conversationId: "chat-10",
  });
  assert.deepEqual(decision, { continue: true });
});
