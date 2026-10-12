const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'archive.db');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

for (const dir of [DATA_DIR, SUMMARIES_DIR, MEDIA_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Ordered schema migrations. PRAGMA user_version records the last applied
 * index, so each migration runs exactly once per database.
 *
 * NOTE: The FTS5 tables are "external content" tables keyed on the implicit
 * rowid of `messages` / `obsidian_notes`. Do NOT run VACUUM on this database
 * without rebuilding the indexes afterwards:
 *   INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
 *   INSERT INTO obsidian_notes_fts(obsidian_notes_fts) VALUES('rebuild');
 */
const migrations = [
  // 1. Baseline schema
  () => {
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

      CREATE TABLE IF NOT EXISTS obsidian_notes (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        rel_path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        checksum TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    if (!hasColumn('messages', 'post_type')) {
      db.exec(`ALTER TABLE messages ADD COLUMN post_type TEXT DEFAULT 'user'`);
    }
  },

  // 2. Indexes, trigger-maintained external-content FTS, drop unused table
  () => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages(conversation_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(is_deleted, updated_at);
      CREATE INDEX IF NOT EXISTS idx_summaries_category ON archive_summaries(category_id, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_summaries_type ON archive_summaries(summary_type, is_deleted);

      DROP TABLE IF EXISTS message_categories;

      -- Replace hand-synced FTS copies with external-content tables
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS obsidian_notes_fts;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE VIRTUAL TABLE obsidian_notes_fts USING fts5(
        title,
        content,
        rel_path,
        content='obsidian_notes',
        content_rowid='rowid'
      );

      CREATE TRIGGER obsidian_fts_ai AFTER INSERT ON obsidian_notes BEGIN
        INSERT INTO obsidian_notes_fts(rowid, title, content, rel_path) VALUES (new.rowid, new.title, new.content, new.rel_path);
      END;
      CREATE TRIGGER obsidian_fts_ad AFTER DELETE ON obsidian_notes BEGIN
        INSERT INTO obsidian_notes_fts(obsidian_notes_fts, rowid, title, content, rel_path) VALUES ('delete', old.rowid, old.title, old.content, old.rel_path);
      END;
      CREATE TRIGGER obsidian_fts_au AFTER UPDATE OF title, content, rel_path ON obsidian_notes BEGIN
        INSERT INTO obsidian_notes_fts(obsidian_notes_fts, rowid, title, content, rel_path) VALUES ('delete', old.rowid, old.title, old.content, old.rel_path);
        INSERT INTO obsidian_notes_fts(rowid, title, content, rel_path) VALUES (new.rowid, new.title, new.content, new.rel_path);
      END;

      INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      INSERT INTO obsidian_notes_fts(obsidian_notes_fts) VALUES ('rebuild');
    `);
  },

  // 3. One active summary per category (+ one global). Older rows are
  //    soft-deleted; the summarizer now upserts instead of appending.
  () => {
    db.exec(`
      UPDATE archive_summaries SET is_deleted = 1
      WHERE is_deleted = 0 AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY summary_type, COALESCE(category_id, '')
            ORDER BY created_at DESC
          ) AS rn
          FROM archive_summaries WHERE is_deleted = 0
        ) WHERE rn = 1
      );
    `);
  },

  // 4. Hybrid search & Digest embeddings schema
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_msg_embeddings_msg ON message_embeddings(message_id);

      CREATE TABLE IF NOT EXISTS summary_embeddings (
        summary_id TEXT PRIMARY KEY REFERENCES archive_summaries(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      DROP TABLE IF EXISTS archive_summaries_fts;
      CREATE VIRTUAL TABLE archive_summaries_fts USING fts5(
        summary_text,
        content='archive_summaries',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS summaries_fts_ai AFTER INSERT ON archive_summaries BEGIN
        INSERT INTO archive_summaries_fts(rowid, summary_text) VALUES (new.rowid, new.summary_text);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_fts_ad AFTER DELETE ON archive_summaries BEGIN
        INSERT INTO archive_summaries_fts(archive_summaries_fts, rowid, summary_text) VALUES ('delete', old.rowid, old.summary_text);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_fts_au AFTER UPDATE OF summary_text ON archive_summaries BEGIN
        INSERT INTO archive_summaries_fts(archive_summaries_fts, rowid, summary_text) VALUES ('delete', old.rowid, old.summary_text);
        INSERT INTO archive_summaries_fts(rowid, summary_text) VALUES (new.rowid, new.summary_text);
      END;

      INSERT INTO archive_summaries_fts(archive_summaries_fts) VALUES ('rebuild');
    `);
  },

  // 5. Obsidian note embeddings schema
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obsidian_note_embeddings (
        note_id TEXT PRIMARY KEY REFERENCES obsidian_notes(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_obsidian_embeddings_note ON obsidian_note_embeddings(note_id);
    `);
  }
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      migrations[i]();
      db.pragma(`user_version = ${i + 1}`);
    })();
    console.log(`[DB] Applied migration ${i + 1}/${migrations.length}`);
  }
}

migrate();

// Default settings if absent
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of [
  ['only_private_ai_summarization', 'false'],
  ['summarizer_model', 'gemma4:12b-mlx'],
  ['summarizer_provider', 'ollama'],
  ['obsidian_vault_path', process.env.OBSIDIAN_VAULT_PATH || ''],
  ['obsidian_last_sync', ''],
  ['embedding_enabled', 'true'],
  ['embedding_provider', 'lmstudio'],
  ['embedding_model', 'text-embedding-nomic-embed-text-v1.5']
]) {
  insertDefault.run(k, v);
}

module.exports = {
  db,
  DATA_DIR,
  SUMMARIES_DIR,
  MEDIA_DIR
};
