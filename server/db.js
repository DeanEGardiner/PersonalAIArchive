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
  },

  // 6. Transition to Dual-Corpus Linked Digests (Search-first digests & deprecating categories)
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_digests (
        id TEXT PRIMARY KEY,
        corpus_type TEXT NOT NULL,         -- 'ai_conversations' | 'obsidian_notes' | 'unified'
        title TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        entities_json TEXT DEFAULT '[]',
        references_json TEXT DEFAULT '[]', -- JSON array: [{ id, title, rel_path, type }]
        coverage_start TIMESTAMP,
        coverage_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_deleted INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_archive_digests_corpus ON archive_digests(corpus_type, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_archive_digests_updated ON archive_digests(updated_at);

      DROP TABLE IF EXISTS archive_digests_fts;
      CREATE VIRTUAL TABLE archive_digests_fts USING fts5(
        title,
        summary_text,
        entities_json,
        content='archive_digests',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS digests_fts_ai AFTER INSERT ON archive_digests BEGIN
        INSERT INTO archive_digests_fts(rowid, title, summary_text, entities_json)
        VALUES (new.rowid, new.title, new.summary_text, new.entities_json);
      END;
      CREATE TRIGGER IF NOT EXISTS digests_fts_ad AFTER DELETE ON archive_digests BEGIN
        INSERT INTO archive_digests_fts(archive_digests_fts, rowid, title, summary_text, entities_json)
        VALUES ('delete', old.rowid, old.title, old.summary_text, old.entities_json);
      END;
      CREATE TRIGGER IF NOT EXISTS digests_fts_au AFTER UPDATE OF title, summary_text, entities_json ON archive_digests BEGIN
        INSERT INTO archive_digests_fts(archive_digests_fts, rowid, title, summary_text, entities_json)
        VALUES ('delete', old.rowid, old.title, old.summary_text, old.entities_json);
        INSERT INTO archive_digests_fts(rowid, title, summary_text, entities_json)
        VALUES (new.rowid, new.title, new.summary_text, new.entities_json);
      END;

      CREATE TABLE IF NOT EXISTS digest_embeddings (
        digest_id TEXT PRIMARY KEY REFERENCES archive_digests(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_digest_embeddings_digest ON digest_embeddings(digest_id);

      -- Migrate historical summaries to archive_digests if not already present
      INSERT INTO archive_digests (id, corpus_type, title, summary_text, entities_json, references_json, coverage_start, coverage_end, created_at, updated_at, is_deleted)
      SELECT 
        s.id, 
        'ai_conversations', 
        COALESCE(c.name, CASE WHEN s.summary_type = 'global' THEN 'Global Executive Archive Digest' ELSE 'Conversation Digest' END),
        s.summary_text,
        '[]',
        '[]',
        s.coverage_start,
        s.coverage_end,
        s.created_at,
        s.updated_at,
        s.is_deleted
      FROM archive_summaries s
      LEFT JOIN categories c ON s.category_id = c.id
      WHERE NOT EXISTS (SELECT 1 FROM archive_digests d WHERE d.id = s.id);

      INSERT INTO archive_digests_fts(archive_digests_fts) VALUES ('rebuild');
    `);
  },

  // 7. Atomic Note Chunking, Chunk Vector Embeddings, and Pre-Search Entity Index
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS obsidian_chunks (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES obsidian_notes(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        start_char INTEGER NOT NULL,
        end_char INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_obsidian_chunks_note ON obsidian_chunks(note_id);

      CREATE TABLE IF NOT EXISTS obsidian_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES obsidian_chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk ON obsidian_chunk_embeddings(chunk_id);

      DROP TABLE IF EXISTS obsidian_chunks_fts;
      CREATE VIRTUAL TABLE obsidian_chunks_fts USING fts5(
        heading,
        content,
        content='obsidian_chunks',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON obsidian_chunks BEGIN
        INSERT INTO obsidian_chunks_fts(rowid, heading, content)
        VALUES (new.rowid, new.heading, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON obsidian_chunks BEGIN
        INSERT INTO obsidian_chunks_fts(obsidian_chunks_fts, rowid, heading, content)
        VALUES ('delete', old.rowid, old.heading, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE OF heading, content ON obsidian_chunks BEGIN
        INSERT INTO obsidian_chunks_fts(obsidian_chunks_fts, rowid, heading, content)
        VALUES ('delete', old.rowid, old.heading, old.content);
        INSERT INTO obsidian_chunks_fts(rowid, heading, content)
        VALUES (new.rowid, new.heading, new.content);
      END;

      CREATE TABLE IF NOT EXISTS archive_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        entity_type TEXT DEFAULT 'general',
        source_type TEXT NOT NULL,         -- 'obsidian_note' | 'conversation'
        source_id TEXT NOT NULL,           -- note_id or conversation_id
        chunk_id TEXT,
        source_ref TEXT,                   -- rel_path or conversation title
        char_offset INTEGER,
        context_snippet TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_archive_entities_norm ON archive_entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_archive_entities_source ON archive_entities(source_type, source_id);
    `);
  },

  // 8. Permanently backfill conversations default_provider and default_model from anchor message
  () => {
    const convs = db.prepare('SELECT id, default_provider, default_model FROM conversations WHERE is_deleted = 0').all();
    const findAnchor = db.prepare(`
      SELECT provider, model FROM messages 
      WHERE conversation_id = ? AND is_deleted = 0 AND provider IS NOT NULL AND provider != 'system'
      ORDER BY timestamp ASC LIMIT 1
    `);
    const updateConv = db.prepare(`
      UPDATE conversations SET default_provider = ?, default_model = ? WHERE id = ?
    `);

    for (const c of convs) {
      const anchor = findAnchor.get(c.id);
      if (anchor && anchor.provider) {
        if (c.default_provider !== anchor.provider || c.default_model !== anchor.model) {
          updateConv.run(anchor.provider, anchor.model, c.id);
        }
      }
    }
  },

  // 9. Backfill obsidian_notes created_at from 'Note created' property
  () => {
    const notes = db.prepare('SELECT id, content FROM obsidian_notes').all();
    const updateStmt = db.prepare('UPDATE obsidian_notes SET created_at = ? WHERE id = ?');
    const patterns = [
      /(?:^|\n)\s*Note\s+created\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*date\s+created\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created\s+date\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created_at\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created\s*:\s*["']?([^"'\r\n]+)["']?/i
    ];

    for (const n of notes) {
      if (!n.content) continue;
      for (const pat of patterns) {
        const match = n.content.match(pat);
        if (match && match[1]) {
          const raw = match[1].trim();
          if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') continue;
          let d = new Date(raw);
          if (isNaN(d.getTime())) {
            d = new Date(raw.replace(/\s+/, 'T'));
          }
          if (!isNaN(d.getTime())) {
            updateStmt.run(d.toISOString(), n.id);
            break;
          }
        }
      }
    }
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
