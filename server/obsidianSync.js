const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, SUMMARIES_DIR } = require('./db');

class ObsidianSyncService {
  /**
   * Get the configured Obsidian vault path from settings
   */
  getVaultPath() {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'obsidian_vault_path'").get();
    return setting?.value?.trim() || '/Users/deangardiner/Documents/DeanGVault';
  }

  /**
   * Set and persist the Obsidian vault path
   */
  setVaultPath(vaultPath) {
    const cleanPath = (vaultPath || '').trim();
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES ('obsidian_vault_path', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(cleanPath);
    return cleanPath;
  }

  /**
   * Validate if the vault path exists and count markdown files
   */
  validateVault(customPath) {
    const vaultPath = customPath || this.getVaultPath();
    if (!vaultPath) {
      return { valid: false, path: '', exists: false, error: 'Vault path is not set.' };
    }

    try {
      if (!fs.existsSync(vaultPath)) {
        return { valid: false, path: vaultPath, exists: false, error: 'Directory does not exist.' };
      }
      const stat = fs.statSync(vaultPath);
      if (!stat.isDirectory()) {
        return { valid: false, path: vaultPath, exists: true, error: 'Path is a file, not a directory.' };
      }

      // Quick count of markdown notes
      const notes = this.findMarkdownFiles(vaultPath);
      return {
        valid: true,
        path: vaultPath,
        exists: true,
        noteCount: notes.length,
        hasAIArchiveDir: fs.existsSync(path.join(vaultPath, 'AI Archive'))
      };
    } catch (err) {
      return { valid: false, path: vaultPath, exists: false, error: err.message };
    }
  }

  /**
   * Recursively locate all markdown files, ignoring .obsidian, .trash, Attachments, and AI Archive
   */
  findMarkdownFiles(dir, baseDir = dir) {
    let results = [];
    const ignoreFolders = new Set(['.obsidian', '.trash', '.git', 'ai archive', 'attachments', 'node_modules']);

    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue; // skip hidden files

        const fullPath = path.join(dir, item.name);
        const lowerName = item.name.toLowerCase();

        if (item.isDirectory()) {
          if (!ignoreFolders.has(lowerName)) {
            results = results.concat(this.findMarkdownFiles(fullPath, baseDir));
          }
        } else if (item.isFile() && item.name.endsWith('.md')) {
          const relPath = path.relative(baseDir, fullPath);
          results.push({ fullPath, relPath, fileName: item.name });
        }
      }
    } catch (err) {
      console.warn(`[ObsidianSync] Warning scanning directory ${dir}:`, err.message);
    }

    return results;
  }

  /**
   * Calculate SHA-256 hash of a string
   */
  computeChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Extract a title from Markdown content or file name
   */
  extractTitle(content, fileName) {
    // Look for first # Heading 1
    const match = content.match(/^#\s+(.+)$/m);
    if (match && match[1]) {
      return match[1].trim();
    }
    // Fall back to filename without extension
    return path.basename(fileName, '.md').trim();
  }

  /**
   * Two-Way Sync:
   * 1. Imports all Obsidian vault notes into obsidian_notes & obsidian_notes_fts
   * 2. Exports all native AI conversations and summaries into <Vault>/AI Archive/
   */
  async sync(customVaultPath) {
    const t0 = Date.now();
    const vaultPath = customVaultPath || this.getVaultPath();
    const validation = this.validateVault(vaultPath);

    if (!validation.valid) {
      throw new Error(`Invalid Obsidian Vault path "${vaultPath}": ${validation.error}`);
    }

    let importedCount = 0;
    let updatedCount = 0;
    let deletedCount = 0;
    let exportedCount = 0;

    // -------------------------------------------------------------
    // PHASE 1: IMPORT FROM OBSIDIAN VAULT (Vault -> DB)
    // -------------------------------------------------------------
    const diskNotes = this.findMarkdownFiles(vaultPath);
    const diskRelPaths = new Set();

    // Prepare DB statements
    const findNoteStmt = db.prepare('SELECT id, checksum, mtime_ms FROM obsidian_notes WHERE rel_path = ?');
    const insertNoteStmt = db.prepare(`
      INSERT INTO obsidian_notes (id, file_name, rel_path, title, content, checksum, mtime_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateNoteStmt = db.prepare(`
      UPDATE obsidian_notes 
      SET title = ?, content = ?, checksum = ?, mtime_ms = ?, updated_at = ?
      WHERE id = ?
    `);
    const insertFtsStmt = db.prepare('INSERT INTO obsidian_notes_fts (title, content, rel_path, note_id) VALUES (?, ?, ?, ?)');
    const deleteFtsStmt = db.prepare('DELETE FROM obsidian_notes_fts WHERE note_id = ?');

    for (const note of diskNotes) {
      diskRelPaths.add(note.relPath);

      try {
        const stat = fs.statSync(note.fullPath);
        const mtimeMs = Math.round(stat.mtimeMs);
        const content = fs.readFileSync(note.fullPath, 'utf8');
        const checksum = this.computeChecksum(content);
        const title = this.extractTitle(content, note.fileName);
        const now = new Date().toISOString();

        const existing = findNoteStmt.get(note.relPath);

        if (!existing) {
          // New note
          const id = uuidv4();
          insertNoteStmt.run(id, note.fileName, note.relPath, title, content, checksum, mtimeMs, now, now);
          insertFtsStmt.run(title, content, note.relPath, id);
          importedCount++;
        } else if (existing.checksum !== checksum || existing.mtime_ms !== mtimeMs) {
          // Modified note
          updateNoteStmt.run(title, content, checksum, mtimeMs, now, existing.id);
          deleteFtsStmt.run(existing.id);
          insertFtsStmt.run(title, content, note.relPath, existing.id);
          updatedCount++;
        }
      } catch (err) {
        console.warn(`[ObsidianSync] Failed to process note ${note.relPath}:`, err.message);
      }
    }

    // Clean up notes in DB that were deleted from disk
    const allDbNotes = db.prepare('SELECT id, rel_path FROM obsidian_notes').all();
    const deleteNoteStmt = db.prepare('DELETE FROM obsidian_notes WHERE id = ?');

    for (const dbNote of allDbNotes) {
      if (!diskRelPaths.has(dbNote.rel_path)) {
        deleteFtsStmt.run(dbNote.id);
        deleteNoteStmt.run(dbNote.id);
        deletedCount++;
      }
    }

    // -------------------------------------------------------------
    // PHASE 2: EXPORT NATIVE AI ARCHIVE TO VAULT (DB -> <Vault>/AI Archive/)
    // -------------------------------------------------------------
    const aiArchiveDir = path.join(vaultPath, 'AI Archive');
    const convDir = path.join(aiArchiveDir, 'Conversations');
    const summDir = path.join(aiArchiveDir, 'Summaries');

    if (!fs.existsSync(aiArchiveDir)) fs.mkdirSync(aiArchiveDir, { recursive: true });
    if (!fs.existsSync(convDir)) fs.mkdirSync(convDir, { recursive: true });
    if (!fs.existsSync(summDir)) fs.mkdirSync(summDir, { recursive: true });

    // 2a. Export Conversations
    const conversations = db.prepare('SELECT * FROM conversations WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    const messageStmt = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY timestamp ASC');

    for (const conv of conversations) {
      const msgs = messageStmt.all(conv.id);
      if (msgs.length === 0) continue;

      const createdDate = conv.created_at ? new Date(conv.created_at).toISOString().split('T')[0] : 'undated';
      const cleanTitle = (conv.title || 'Untitled Conversation')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50);

      const fileName = `${createdDate}_${cleanTitle || 'Conversation'}_${conv.id.slice(0, 6)}.md`;
      const targetFilePath = path.join(convDir, fileName);

      // Build clean Markdown note
      let mdContent = `---
id: "${conv.id}"
title: "${(conv.title || '').replace(/"/g, '\\"')}"
date: "${createdDate}"
provider: "${conv.default_provider || 'local'}"
model: "${conv.default_model || ''}"
tags:
  - "ai-archive"
  - "conversation"
source: "Personal AI Archive"
---

# ${conv.title || 'Conversation'}

*Exported from Personal AI Archive on ${new Date().toLocaleDateString()}*

---

`;

      for (const m of msgs) {
        const roleLabel = m.role === 'user' ? '👤 User' : `🤖 Assistant (${m.model || m.provider || 'AI'})`;
        const timeStr = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        mdContent += `### ${roleLabel}${timeStr ? ` · *${timeStr}*` : ''}\n\n`;
        mdContent += `${m.content.trim()}\n\n---\n\n`;
      }

      // Only write if new or changed
      let shouldWrite = true;
      if (fs.existsSync(targetFilePath)) {
        const existingContent = fs.readFileSync(targetFilePath, 'utf8');
        if (existingContent === mdContent) shouldWrite = false;
      }

      if (shouldWrite) {
        fs.writeFileSync(targetFilePath, mdContent, 'utf8');
        exportedCount++;
      }
    }

    // 2b. Export Summaries
    const dbSummaries = db.prepare(`
      SELECT s.*, c.name as category_name, c.description as category_desc 
      FROM archive_summaries s
      LEFT JOIN categories c ON s.category_id = c.id
      WHERE s.is_deleted = 0
    `).all();

    for (const s of dbSummaries) {
      let fileName = 'Global_Archive_Digest.md';
      let title = 'Global Executive Archive Digest';

      if (s.category_name) {
        const safeCat = s.category_name.replace(/[/\\?%*:|"<>]/g, '_').trim();
        fileName = `${safeCat}.md`;
        title = `${s.category_name} Digest`;
      }

      const targetPath = path.join(summDir, fileName);
      const summContent = `---
type: "archive_digest"
title: "${title}"
updated: "${s.updated_at || s.created_at}"
source: "Personal AI Archive"
tags:
  - "ai-archive"
  - "digest"
---

# ${title}

${s.summary_text}
`;

      let shouldWrite = true;
      if (fs.existsSync(targetPath)) {
        const existing = fs.readFileSync(targetPath, 'utf8');
        if (existing === summContent) shouldWrite = false;
      }

      if (shouldWrite) {
        fs.writeFileSync(targetPath, summContent, 'utf8');
        exportedCount++;
      }
    }

    const durationMs = Date.now() - t0;
    const nowIso = new Date().toISOString();

    // Update last sync setting
    db.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES ('obsidian_last_sync', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(nowIso);

    return {
      success: true,
      vaultPath,
      totalVaultNotes: diskNotes.length,
      importedCount,
      updatedCount,
      deletedCount,
      exportedCount,
      durationMs,
      lastSync: nowIso
    };
  }

  /**
   * Search synced Obsidian notes using FTS5
   */
  searchNotes(query, limit = 50) {
    if (!query || !query.trim()) {
      return db.prepare(`
        SELECT id, file_name, rel_path, title, substr(content, 1, 200) as preview, mtime_ms, updated_at
        FROM obsidian_notes
        ORDER BY mtime_ms DESC
        LIMIT ?
      `).all(limit);
    }

    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const words = cleanQuery.split(/\s+/).filter(w => w.length > 1);

    if (words.length === 0) {
      return [];
    }

    try {
      const ftsExpr = words.map(w => `${w}*`).join(' OR ');
      return db.prepare(`
        SELECT n.id, n.file_name, n.rel_path, n.title, substr(n.content, 1, 250) as preview, n.mtime_ms, n.updated_at
        FROM obsidian_notes_fts fts
        JOIN obsidian_notes n ON fts.note_id = n.id
        WHERE obsidian_notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsExpr, limit);
    } catch (err) {
      // Fallback to LIKE
      return db.prepare(`
        SELECT id, file_name, rel_path, title, substr(content, 1, 200) as preview, mtime_ms, updated_at
        FROM obsidian_notes
        WHERE title LIKE ? OR content LIKE ?
        ORDER BY mtime_ms DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit);
    }
  }

  /**
   * Get single note by ID
   */
  getNoteById(id) {
    return db.prepare('SELECT * FROM obsidian_notes WHERE id = ?').get(id);
  }

  /**
   * Get sync status overview
   */
  getStatus() {
    const vaultPath = this.getVaultPath();
    const validation = this.validateVault(vaultPath);
    const lastSyncSetting = db.prepare("SELECT value FROM settings WHERE key = 'obsidian_last_sync'").get();
    const countRow = db.prepare('SELECT COUNT(*) as total FROM obsidian_notes').get();

    return {
      vaultPath,
      isValid: validation.valid,
      exists: validation.exists,
      diskNoteCount: validation.noteCount || 0,
      databaseNoteCount: countRow?.total || 0,
      lastSync: lastSyncSetting?.value || null,
      error: validation.error || null
    };
  }
}

module.exports = new ObsidianSyncService();
