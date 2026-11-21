import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import { THEMES } from "../shared/themes.js";
import { insertSubmission, listSubmissions, openDatabase } from "./db.js";
import { validateSubmission } from "./validate.js";

const port = Number(process.env.PORT) || 8787;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = openDatabase();
const app = express();

app.use(express.json());

app.get("/api/themes", (_req, res) => {
  res.json({ themes: THEMES });
});

app.get("/api/submissions", (_req, res) => {
  res.json({ submissions: listSubmissions(db) });
});

app.post("/api/submissions", (req, res) => {
  const result = validateSubmission(req.body);
  if (!result.ok) {
    res.status(400).json({ errors: result.errors });
    return;
  }
  res.status(201).json({ submission: insertSubmission(db, result.value) });
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(port, "127.0.0.1", () => {
  console.log(`HackCulturee API on http://127.0.0.1:${port}`);
});
