const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'videoeditor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clips (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    file_path TEXT NOT NULL,
    duration  REAL DEFAULT 0,
    added_at  TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
