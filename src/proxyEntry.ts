import fs from "fs";
import os from "os";
import path from "path";
import type { ProxySpend } from "./core/proxy";
import { formatTokenNotice, type TurnNotice } from "./core/cursorTurn";
import { startProxy } from "./proxyServer";

const upstream = process.env.TOKENPILOT_UPSTREAM || "http://127.0.0.1:8080";
const port = Number(process.env.TOKENPILOT_PORT || 8787);
const key = process.env.TOKENPILOT_BIFROST_KEY?.trim() || "";
const latest = path.join(os.homedir(), ".cursor", "tokenpilot", "latest.json");

startProxy({
  port,
  upstream,
  key,
  onSpend: (spend) => {
    const notice = noticeFrom(spend);
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    const tmp = `${latest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notice));
    fs.renameSync(tmp, latest);
    process.stdout.write(`${formatTokenNotice(notice)}\n`);
  },
})
  .then((proxy) => {
    process.stdout.write(`TokenPilot proxy listening on http://127.0.0.1:${proxy.port}/v1\n`);
  })
  .catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? `${error.message}\n` : "TokenPilot proxy failed to start.\n");
    process.exit(1);
  });

function noticeFrom(spend: ProxySpend): TurnNotice {
  return {
    id: spend.id,
    conversationId: "proxy",
    status: "completed",
    source: "proxy",
    model: spend.model,
    reducedTokens: spend.afterTokens,
    promptTokens: spend.usage?.promptTokens ?? spend.afterTokens,
    baselineTokens: spend.beforeTokens,
    userBefore: 0,
    userAfter: 0,
    harnessBefore: 0,
    harnessAfter: 0,
    actualPromptTokens: spend.usage?.promptTokens,
    actualCompletionTokens: spend.usage?.completionTokens,
    keptTools: spend.keptTools,
    droppedTools: spend.droppedTools,
  };
}
