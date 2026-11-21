import fs from "fs";

export function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) {
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const split = line.indexOf("=");
    if (split <= 0) {
      continue;
    }
    const key = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
