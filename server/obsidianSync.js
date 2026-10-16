const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const config = require('./config');
const embeddingService = require('./embeddingService');

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'to', 'in', 'a', 'an', 'is', 'it', 'you', 'that', 'he',
  'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'i', 'at', 'be',
  'this', 'have', 'from', 'or', 'one', 'had', 'by', 'word', 'but', 'not',
  'what', 'all', 'were', 'we', 'when', 'your', 'can', 'said', 'there', 'use',
  'an', 'each', 'which', 'she', 'do', 'how', 'their', 'if', 'will', 'up',
  'other', 'about', 'out', 'many', 'then', 'them', 'these', 'so', 'some', 'her',
  'would', 'make', 'like', 'him', 'into', 'time', 'has', 'look', 'two', 'more',
  'write', 'go', 'see', 'number', 'no', 'way', 'could', 'people', 'my', 'than',
  'first', 'water', 'been', 'call', 'who', 'oil', 'its', 'now', 'find', 'long',
  'down', 'day', 'did', 'get', 'come', 'made', 'may', 'part', 'please', 'check',
  'search', 'query', 'show', 'give', 'details', 'information', 'tell', 'me',
  'note', 'notes', 'vault', 'file', 'files'
]);

class ObsidianSyncService {
  getVaultPath() {
    return config.getSetting('obsidian_vault_path') || config.getDefaultVaultPath();
  }

  setVaultPath(vaultPath) {
    const cleanPath = (vaultPath || '').trim();
    config.setSetting('obsidian_vault_path', cleanPath);
    return cleanPath;
  }

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

      return {
        valid: true,
        path: vaultPath,
        exists: true,
        hasAIArchiveDir: fs.existsSync(path.join(vaultPath, 'AI Archive'))
      };
    } catch (err) {
      return { valid: false, path: vaultPath, exists: false, error: err.message };
    }
  }

  findMarkdownFiles(dir, baseDir = dir) {
    let results = [];
    const ignoreFolders = new Set(['.obsidian', '.trash', '.git', 'ai archive', 'attachments', 'node_modules']);

    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;

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

  computeChecksum(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  extractTitle(content, fileName) {
    const match = content.match(/^#\s+(.+)$/m);
    if (match && match[1]) {
      return match[1].trim();
    }
    return path.basename(fileName, '.md').trim();
  }

  extractNoteCreatedDate(content) {
    if (!content || typeof content !== 'string') return null;

    const patterns = [
      /(?:^|\n)\s*Note\s+created\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*date\s+created\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created\s+date\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created_at\s*:\s*["']?([^"'\r\n]+)["']?/i,
      /(?:^|\n)\s*created\s*:\s*["']?([^"'\r\n]+)["']?/i
    ];

    for (const pat of patterns) {
      const match = content.match(pat);
      if (match && match[1]) {
        const raw = match[1].trim();
        if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') continue;

        let d = new Date(raw);
        if (isNaN(d.getTime())) {
          d = new Date(raw.replace(/\s+/, 'T'));
        }
        if (!isNaN(d.getTime())) {
          return d.toISOString();
        }
      }
    }

    return null;
  }

  /**
   * Two-Way Sync (Transactional & Incremental)
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

    // 1. IMPORT FROM OBSIDIAN VAULT (Vault -> DB)
    const diskNotes = this.findMarkdownFiles(vaultPath);
    const diskRelPaths = new Set();

    const findNoteStmt = db.prepare('SELECT id, title, checksum, mtime_ms FROM obsidian_notes WHERE rel_path = ?');
    const insertNoteStmt = db.prepare(`
      INSERT INTO obsidian_notes (id, file_name, rel_path, title, content, checksum, mtime_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateNoteStmt = db.prepare(`
      UPDATE obsidian_notes 
      SET title = ?, content = ?, checksum = ?, mtime_ms = ?, updated_at = ?
      WHERE id = ?
    `);
    const deleteNoteStmt = db.prepare('DELETE FROM obsidian_notes WHERE id = ?');
    const deleteEntitiesStmt = db.prepare("DELETE FROM archive_entities WHERE source_type = 'obsidian_note' AND source_id = ?");
    const allDbNotes = db.prepare('SELECT id, rel_path FROM obsidian_notes').all();

    // Run import inside a single database transaction
    db.transaction(() => {
      for (const note of diskNotes) {
        diskRelPaths.add(note.relPath);

        try {
          const stat = fs.statSync(note.fullPath);
          const mtimeMs = Math.round(stat.mtimeMs);
          const existing = findNoteStmt.get(note.relPath);

          // Fast skip ONLY if mtime is unchanged AND chunks already exist in DB
          if (existing && existing.mtime_ms === mtimeMs) {
            const hasChunks = db.prepare('SELECT count(*) as c FROM obsidian_chunks WHERE note_id = ?').get(existing.id)?.c > 0;
            if (hasChunks) {
              continue;
            }
          }

          const content = fs.readFileSync(note.fullPath, 'utf8');
          const checksum = this.computeChecksum(content);

          const noteCreated = this.extractNoteCreatedDate(content);

          if (existing && existing.checksum === checksum) {
            // Content identical, update mtime and only create chunks if missing
            const noteTitle = existing.title || this.extractTitle(content, note.fileName);
            if (noteCreated) {
              db.prepare('UPDATE obsidian_notes SET created_at = ? WHERE id = ?').run(noteCreated, existing.id);
            }
            updateNoteStmt.run(noteTitle, content, checksum, mtimeMs, new Date().toISOString(), existing.id);
            const hasChunks = db.prepare('SELECT count(*) as c FROM obsidian_chunks WHERE note_id = ?').get(existing.id)?.c > 0;
            if (!hasChunks) {
              this.processNoteChunksAndEntities(existing.id, noteTitle, note.relPath, content);
            }
            continue;
          }

          const title = this.extractTitle(content, note.fileName);
          const now = new Date().toISOString();
          const createdAt = noteCreated || now;

          if (!existing) {
            const id = uuidv4();
            insertNoteStmt.run(id, note.fileName, note.relPath, title, content, checksum, mtimeMs, createdAt, now);
            importedCount++;
            this.processNoteChunksAndEntities(id, title, note.relPath, content);
            embeddingService.queueObsidianNote(id, `${title}\n\n${content}`.slice(0, 4000));
          } else {
            if (noteCreated) {
              db.prepare('UPDATE obsidian_notes SET created_at = ? WHERE id = ?').run(noteCreated, existing.id);
            }
            updateNoteStmt.run(title, content, checksum, mtimeMs, now, existing.id);
            updatedCount++;
            this.processNoteChunksAndEntities(existing.id, title, note.relPath, content);
            embeddingService.queueObsidianNote(existing.id, `${title}\n\n${content}`.slice(0, 4000));
          }
        } catch (err) {
          console.warn(`[ObsidianSync] Failed to process note ${note.relPath}:`, err.message);
        }
      }

      // Clean up notes in DB deleted from disk (and clean up their non-FK entities)
      for (const dbNote of allDbNotes) {
        if (!diskRelPaths.has(dbNote.rel_path)) {
          deleteNoteStmt.run(dbNote.id);
          deleteEntitiesStmt.run(dbNote.id);
          deletedCount++;
        }
      }
    })();

    // 2. EXPORT NATIVE AI ARCHIVE TO VAULT (DB -> <Vault>/AI Archive/)
    const aiArchiveDir = path.join(vaultPath, 'AI Archive');
    const convDir = path.join(aiArchiveDir, 'Conversations');
    const summDir = path.join(aiArchiveDir, 'Summaries');

    fs.mkdirSync(aiArchiveDir, { recursive: true });
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(summDir, { recursive: true });

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
    config.setSetting('obsidian_last_sync', nowIso);

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

  searchNotes(query, limit = 50) {
    if (!query || !query.trim()) {
      return db.prepare(`
        SELECT id, file_name, rel_path, title, substr(content, 1, 200) as preview, mtime_ms, created_at, updated_at
        FROM obsidian_notes
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
    }

    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const rawWords = cleanQuery.split(/\s+/).filter(w => w.length > 1);
    const keywords = rawWords.filter(w => !STOP_WORDS.has(w));
    const searchTerms = keywords.length > 0 ? keywords : rawWords;

    if (searchTerms.length === 0) {
      return [];
    }

    let ftsHits = [];
    try {
      // 1. Try AND match on meaningful terms first
      const andExpr = searchTerms.map(w => `${w}*`).join(' AND ');
      ftsHits = db.prepare(`
        SELECT n.id, n.file_name, n.rel_path, n.title, substr(n.content, 1, 250) as preview, n.mtime_ms, n.created_at, n.updated_at
        FROM obsidian_notes_fts fts
        JOIN obsidian_notes n ON fts.rowid = n.rowid
        WHERE obsidian_notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(andExpr, limit);

      // 2. If no hits and multiple terms, fallback to OR on meaningful terms
      if (ftsHits.length === 0 && searchTerms.length > 1) {
        const orExpr = searchTerms.map(w => `${w}*`).join(' OR ');
        ftsHits = db.prepare(`
          SELECT n.id, n.file_name, n.rel_path, n.title, substr(n.content, 1, 250) as preview, n.mtime_ms, n.created_at, n.updated_at
          FROM obsidian_notes_fts fts
          JOIN obsidian_notes n ON fts.rowid = n.rowid
          WHERE obsidian_notes_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `).all(orExpr, limit);
      }
    } catch (_) {
      ftsHits = db.prepare(`
        SELECT id, file_name, rel_path, title, substr(content, 1, 200) as preview, mtime_ms, created_at, updated_at
        FROM obsidian_notes
        WHERE title LIKE ? OR content LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(`%${cleanQuery}%`, `%${cleanQuery}%`, limit);
    }

    return ftsHits;
  }

  chunkNoteContent(content, maxChunkChars = 1500, overlapChars = 200) {
    if (!content || !content.trim()) return [];

    const lines = content.split('\n');
    const sections = [];
    let currentHeading = 'Document';
    let currentLines = [];
    let currentStartChar = 0;
    let currentCharIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^(#{1,4}\s+.+)$/);

      if (headingMatch && currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          text: currentLines.join('\n'),
          startChar: currentStartChar,
          endChar: currentCharIndex - 1
        });
        currentHeading = headingMatch[1].replace(/^#+\s+/, '').trim();
        currentLines = [line];
        currentStartChar = currentCharIndex;
      } else {
        if (headingMatch && currentLines.length === 0) {
          currentHeading = headingMatch[1].replace(/^#+\s+/, '').trim();
        }
        currentLines.push(line);
      }
      currentCharIndex += line.length + 1;
    }

    if (currentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        text: currentLines.join('\n'),
        startChar: currentStartChar,
        endChar: currentCharIndex - 1
      });
    }

    const chunks = [];
    let chunkIndex = 0;

    for (const sec of sections) {
      if (sec.text.length <= maxChunkChars) {
        chunks.push({
          chunkIndex: chunkIndex++,
          heading: sec.heading,
          startChar: sec.startChar,
          endChar: sec.endChar,
          content: sec.text.trim()
        });
      } else {
        const paragraphs = sec.text.split(/\n\s*\n/);
        let curChunk = '';
        let chunkStart = sec.startChar;
        let runningOffset = sec.startChar;

        for (const p of paragraphs) {
          const trimmedP = p.trim();
          if (!trimmedP) {
            runningOffset += p.length + 2;
            continue;
          }

          if (curChunk.length + trimmedP.length + 2 <= maxChunkChars) {
            curChunk += (curChunk ? '\n\n' : '') + trimmedP;
          } else {
            if (curChunk) {
              chunks.push({
                chunkIndex: chunkIndex++,
                heading: sec.heading,
                startChar: chunkStart,
                endChar: runningOffset - 1,
                content: curChunk.trim()
              });
              chunkStart = runningOffset;
            }
            if (trimmedP.length > maxChunkChars) {
              for (let s = 0; s < trimmedP.length; s += (maxChunkChars - overlapChars)) {
                const subText = trimmedP.slice(s, s + maxChunkChars);
                chunks.push({
                  chunkIndex: chunkIndex++,
                  heading: sec.heading,
                  startChar: runningOffset + s,
                  endChar: runningOffset + Math.min(s + maxChunkChars, trimmedP.length),
                  content: subText.trim()
                });
              }
            } else {
              curChunk = trimmedP;
            }
          }
          runningOffset += p.length + 2;
        }

        if (curChunk) {
          chunks.push({
            chunkIndex: chunkIndex++,
            heading: sec.heading,
            startChar: chunkStart,
            endChar: runningOffset - 1,
            content: curChunk.trim()
          });
        }
      }
    }

    return chunks.filter(c => c.content && c.content.length > 20);
  }

  extractEntitiesFromText(text) {
    if (!text || typeof text !== 'string') return [];
    const entities = new Map();

    const addEntity = (rawName, entityType, offset, snippet) => {
      if (!rawName) return;
      const clean = rawName.replace(/^["'`]|["'`]$/g, '').trim();
      if (clean.length < 2 || clean.length > 60) return;
      const norm = clean.toLowerCase();
      if (/^\d+$/.test(norm) || STOP_WORDS.has(norm)) return;

      if (!entities.has(norm)) {
        entities.set(norm, {
          name: clean,
          normalizedName: norm,
          entityType,
          offset: offset || 0,
          snippet: snippet || clean,
          count: 1
        });
      } else {
        entities.get(norm).count++;
      }
    };

    // 1. Wiki-links [[Entity Name]] or [[Entity Name|Label]]
    const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = wikiRegex.exec(text)) !== null) {
      const matchPos = m.index;
      const snippet = text.slice(Math.max(0, matchPos - 40), Math.min(text.length, matchPos + 80)).replace(/\n/g, ' ');
      addEntity(m[1].trim(), 'wikilink', matchPos, snippet);
    }

    // 2. Markdown tags #tag-name
    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\/]{2,30})\b/g;
    while ((m = tagRegex.exec(text)) !== null) {
      const matchPos = m.index;
      const snippet = text.slice(Math.max(0, matchPos - 40), Math.min(text.length, matchPos + 80)).replace(/\n/g, ' ');
      addEntity(m[1].trim(), 'tag', matchPos, snippet);
    }

    // 3. Multi-word Proper Noun Phrases (e.g. "The Black Crowes", "Enmore Theatre", "LM Studio")
    const properNounRegex = /\b(?:The\s+)?[A-Z][a-zA-Z0-9]*(?:\s+(?:and|of|the|at|in|on|for|&|de|la)\s+[A-Z][a-zA-Z0-9]*|\s+[A-Z][a-zA-Z0-9]*)+\b/g;
    while ((m = properNounRegex.exec(text)) !== null) {
      const matchPos = m.index;
      const phrase = m[0].trim();
      if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/.test(phrase)) {
        continue;
      }
      const snippet = text.slice(Math.max(0, matchPos - 40), Math.min(text.length, matchPos + 80)).replace(/\n/g, ' ');
      addEntity(phrase, 'proper_noun', matchPos, snippet);
    }

    return Array.from(entities.values());
  }

  processNoteChunksAndEntities(noteId, title, relPath, content) {
    if (!noteId || !content) return;

    db.prepare('DELETE FROM obsidian_chunks WHERE note_id = ?').run(noteId);
    db.prepare("DELETE FROM archive_entities WHERE source_type = 'obsidian_note' AND source_id = ?").run(noteId);

    const insertEntityStmt = db.prepare(`
      INSERT OR IGNORE INTO archive_entities (
        id, name, normalized_name, entity_type, source_type, source_id, chunk_id, source_ref, char_offset, context_snippet
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (title && title.length > 1) {
      insertEntityStmt.run(
        uuidv4(),
        title,
        title.toLowerCase().trim(),
        'note_title',
        'obsidian_note',
        noteId,
        null,
        relPath,
        0,
        `Note: ${title} (${relPath})`
      );
    }

    const chunks = this.chunkNoteContent(content);
    const insertChunkStmt = db.prepare(`
      INSERT INTO obsidian_chunks (id, note_id, chunk_index, heading, start_char, end_char, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      const chunkId = uuidv4();
      insertChunkStmt.run(
        chunkId,
        noteId,
        chunk.chunkIndex,
        chunk.heading || null,
        chunk.startChar,
        chunk.endChar,
        chunk.content
      );

      try {
        embeddingService.queueChunk(chunkId, chunk.content);
      } catch (_) {}

      const chunkEntities = this.extractEntitiesFromText(chunk.content);
      for (const ent of chunkEntities) {
        insertEntityStmt.run(
          uuidv4(),
          ent.name,
          ent.normalizedName,
          ent.entityType,
          'obsidian_note',
          noteId,
          chunkId,
          relPath,
          chunk.startChar + ent.offset,
          ent.snippet
        );
      }
    }
  }

  reindexAllNotes() {
    const notes = db.prepare('SELECT id, title, rel_path, content FROM obsidian_notes').all();

    db.transaction(() => {
      for (const note of notes) {
        this.processNoteChunksAndEntities(note.id, note.title, note.rel_path, note.content);
      }
    })();

    const chunkRow = db.prepare('SELECT COUNT(*) as c FROM obsidian_chunks').get();
    const entRow = db.prepare('SELECT COUNT(*) as c FROM archive_entities').get();

    return {
      totalNotes: notes.length,
      totalChunks: chunkRow?.c || 0,
      totalEntities: entRow?.c || 0
    };
  }

  getNoteById(id) {
    if (!id) return null;
    const note = db.prepare('SELECT * FROM obsidian_notes WHERE id = ?').get(id);
    if (note) return note;

    const chunkNote = db.prepare(`
      SELECT n.* FROM obsidian_notes n
      JOIN obsidian_chunks c ON c.note_id = n.id
      WHERE c.id = ?
    `).get(id);
    return chunkNote || null;
  }

  getNoteByPath(relPath) {
    if (!relPath) return null;
    return db.prepare('SELECT * FROM obsidian_notes WHERE rel_path = ?').get(relPath) || null;
  }

  getStatus() {
    const vaultPath = this.getVaultPath();
    const validation = this.validateVault(vaultPath);
    const lastSync = config.getSetting('obsidian_last_sync');
    const countRow = db.prepare('SELECT COUNT(*) as total FROM obsidian_notes').get();

    return {
      vaultPath,
      isValid: validation.valid,
      exists: validation.exists,
      diskNoteCount: countRow?.total || 0,
      databaseNoteCount: countRow?.total || 0,
      lastSync: lastSync || null,
      error: validation.error || null
    };
  }
}

const instance = new ObsidianSyncService();

try {
  const noteCount = db.prepare('SELECT count(*) as c FROM obsidian_notes').get()?.c || 0;
  const chunkCount = db.prepare('SELECT count(*) as c FROM obsidian_chunks').get()?.c || 0;
  if (noteCount > 0 && chunkCount === 0) {
    console.log(`[ObsidianSync] Initializing chunks for ${noteCount} notes...`);
    instance.reindexAllNotes();
  }
} catch (err) {
  console.warn('[ObsidianSync] Auto-chunk initialization check failed:', err.message);
}

module.exports = instance;
