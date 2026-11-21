import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const dbPath = path.join(dataDir, "submissions.sqlite");

export function openDatabase() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_name TEXT NOT NULL,
      leader_name TEXT NOT NULL DEFAULT '',
      member_count INTEGER NOT NULL DEFAULT 0,
      theme TEXT NOT NULL,
      summary TEXT NOT NULL,
      github_url TEXT NOT NULL,
      demo_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const columns = db.prepare("PRAGMA table_info(submissions)").all();
  if (!columns.some((column) => column.name === "leader_name")) {
    db.exec("ALTER TABLE submissions ADD COLUMN leader_name TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === "member_count")) {
    db.exec("ALTER TABLE submissions ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

export function insertSubmission(db, value) {
  const result = db
    .prepare(
      `INSERT INTO submissions (team_name, leader_name, member_count, theme, summary, github_url, demo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.teamName,
      value.leaderName,
      value.memberCount,
      value.theme,
      value.summary,
      value.githubUrl,
      value.demoUrl,
    );
  return getSubmission(db, Number(result.lastInsertRowid));
}

export function getSubmission(db, id) {
  return mapRow(
    db.prepare("SELECT id, team_name, leader_name, member_count, theme, summary, github_url, demo_url, created_at FROM submissions WHERE id = ?").get(id),
  );
}

export function listSubmissions(db) {
  const rows = db
    .prepare(
      "SELECT id, team_name, leader_name, member_count, theme, summary, github_url, demo_url, created_at FROM submissions ORDER BY id DESC LIMIT 8",
    )
    .all();
  return rows.map(mapRow);
}

function mapRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    teamName: row.team_name,
    leaderName: row.leader_name,
    memberCount: row.member_count,
    theme: row.theme,
    summary: row.summary,
    githubUrl: row.github_url,
    demoUrl: row.demo_url,
    createdAt: row.created_at,
  };
}
