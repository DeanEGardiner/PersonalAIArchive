const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'archive.db');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUMMARIES_DIR)) fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      device_id TEXT DEFAULT 'local_mac',
      is_deleted INTEGER DEFAULT 0,
      default_provider TEXT,
      default_model TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'completed',
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      device_id TEXT DEFAULT 'local_mac',
      is_deleted INTEGER DEFAULT 0,
      provider TEXT,
      model TEXT,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      file_name TEXT,
      file_path TEXT,
      mime_type TEXT,
      file_size INTEGER,
      checksum TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      device_id TEXT DEFAULT 'local_mac',
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_categories (
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
      PRIMARY KEY(message_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS archive_summaries (
      id TEXT PRIMARY KEY,
      category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
      summary_text TEXT,
      coverage_start TIMESTAMP,
      coverage_end TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      device_id TEXT DEFAULT 'local_mac',
      is_deleted INTEGER DEFAULT 0,
      summary_type TEXT DEFAULT 'category' -- 'global' or 'category'
    );

    -- Full-Text Search Virtual Table
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      message_id UNINDEXED,
      role UNINDEXED,
      timestamp UNINDEXED
    );
  `);

  // Ensure post_type column exists on messages table for new and existing databases
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN post_type TEXT DEFAULT 'user'`);
  } catch (_) {}

  // Default settings if absent
  const checkSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  if (!checkSetting.get('only_private_ai_summarization')) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('only_private_ai_summarization', 'false');
  }
  if (!checkSetting.get('summarizer_model')) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('summarizer_model', 'gemma4:12b-mlx');
  }
  if (!checkSetting.get('summarizer_provider')) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('summarizer_provider', 'ollama');
  }
}

initSchema();

module.exports = {
  db,
  DATA_DIR,
  SUMMARIES_DIR,
  MEDIA_DIR
};
