import { reduceProviderPayload } from "./core/reduce";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) {
    process.stderr.write("Paste a chat or responses JSON body on stdin.\nExample: npm run reduce < request.json\n");
    process.exit(1);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    process.stderr.write("The body is not JSON.\n");
    process.exit(1);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    process.stderr.write("The body must be a JSON object.\n");
    process.exit(1);
  }
  const report = reduceProviderPayload(body as Record<string, unknown>);
  process.stderr.write(
    `Reduced ${report.beforeTokens} → ${report.afterTokens} (saved ${report.saved}, ${report.savedPct}%). Task ${report.task}.\n` +
      `Kept: ${report.keptTools.join(", ") || "none"}.\n` +
      `Dropped: ${report.droppedTools.join(", ") || "none"}.\n`,
  );
  process.stdout.write(JSON.stringify(report.payload, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
