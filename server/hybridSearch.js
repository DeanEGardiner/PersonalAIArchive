const { db } = require('./db');
const embeddingService = require('./embeddingService');
const obsidianSync = require('./obsidianSync');

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
  // Conversational filler & search directives
  'entries', 'entry', 'where', 'talked', 'talking', 'talk', 'mentioned', 'mentioning',
  'mention', 'discuss', 'discussed', 'discussing', 'notes', 'note',
  'vault', 'file', 'files', 'any', 'anyone', 'anything', 'also', 'just', 'recent',
  'recently', 'last', 'past', 'history', 'archive', 'log', 'logs', 'journal',
  'journals', 'remember', 'recall', 'tell'
]);

class HybridSearchEngine {
  extractKeywords(query) {
    if (!query) return [];
    return query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }

  // Reciprocal Rank Fusion (RRF): score = weight / (k + rank)
  combineRRF(rankedLists, k = 60, weights = []) {
    const scores = new Map();
    const itemMap = new Map();

    rankedLists.forEach((list, listIndex) => {
      if (!Array.isArray(list)) return;
      const weight = (weights && weights[listIndex] !== undefined) ? weights[listIndex] : 1.0;
      list.forEach((item, index) => {
        if (!item || !item.id) return;
        const currentScore = scores.get(item.id) || 0;
        scores.set(item.id, currentScore + (weight / (k + index + 1)));
        if (!itemMap.has(item.id)) {
          itemMap.set(item.id, item);
        }
      });
    });

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({
        ...itemMap.get(id),
        rrfScore: score
      }));
  }

  // Smart snippet window centered around matching query terms using phrase matching & density scoring
  extractCenteredSnippet(content, keywords = [], maxChars = 800) {
    if (!content) return '';
    if (content.length <= maxChars) return content;

    const lower = content.toLowerCase();
    let bestPos = -1;

    // 1. Try finding multi-word contiguous phrase first (e.g. "black crowes")
    if (keywords.length >= 2) {
      const phrase = keywords.join(' ');
      const pIndex = lower.indexOf(phrase);
      if (pIndex !== -1) {
        bestPos = pIndex;
      }
    }

    // 2. Score candidate windows by keyword density with word boundaries
    if (bestPos === -1 && keywords.length > 0) {
      let maxScore = -1;
      const matches = [];
      for (const kw of keywords) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'gi');
        let m;
        while ((m = re.exec(content)) !== null) {
          matches.push(m.index);
        }
      }

      if (matches.length > 0) {
        for (const pos of matches) {
          const wStart = Math.max(0, pos - Math.floor(maxChars / 2));
          const wEnd = Math.min(content.length, wStart + maxChars);
          const sub = lower.slice(wStart, wEnd);

          let score = 0;
          for (const kw of keywords) {
            const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const kwMatches = (sub.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length;
            score += kwMatches * (kw.length > 4 ? 2 : 1);
          }

          if (score > maxScore) {
            maxScore = score;
            bestPos = pos;
          }
        }
      } else {
        // Substring fallback if word boundaries didn't hit
        for (const kw of keywords) {
          const pos = lower.indexOf(kw.toLowerCase());
          if (pos !== -1) {
            bestPos = pos;
            break;
          }
        }
      }
    }

    // Default to start if no keyword found
    if (bestPos === -1) {
      return content.slice(0, maxChars) + '... [truncated]';
    }

    const half = Math.floor(maxChars / 2);
    let start = Math.max(0, bestPos - half);
    let end = Math.min(content.length, start + maxChars);

    if (end - start < maxChars && start > 0) {
      start = Math.max(0, end - maxChars);
    }

    // Adjust to nearest sentence or line boundary if reasonable
    if (start > 0) {
      const lineStart = content.lastIndexOf('\n', start + 40);
      if (lineStart !== -1 && lineStart >= start - 40 && lineStart < start + 60) {
        start = lineStart + 1;
      }
    }

    let snippet = content.slice(start, end).trim();
    if (start > 0) snippet = '... ' + snippet;
    if (end < content.length) snippet = snippet + ' ... [truncated]';

    return snippet;
  }

  // -------------------------------------------------------------
  // Tier 1: Search Archive Digests (Dual-Corpus: AI Chats & Obsidian Notes)
  // -------------------------------------------------------------
  async searchDigests(query, queryVector = null, limit = 3, corpusType = null) {
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const ftsQuery = keywords.map(k => `${k}*`).join(' OR ');
        const filterClause = corpusType ? 'AND d.corpus_type = ?' : '';
        const params = corpusType ? [ftsQuery, corpusType] : [ftsQuery];
        const rows = db.prepare(`
          SELECT d.id, d.corpus_type, d.title, d.summary_text, d.entities_json, d.references_json
          FROM archive_digests_fts fts
          JOIN archive_digests d ON fts.rowid = d.rowid
          WHERE archive_digests_fts MATCH ? AND d.is_deleted = 0 ${filterClause}
          LIMIT 15
        `).all(...params);
        ftsHits.push(...rows);
      } catch (err) {
        console.warn('[Digest FTS Warning]:', err.message);
      }
    }

    const vectorHits = [];
    if (queryVector) {
      try {
        const filterClause = corpusType ? 'AND d.corpus_type = ?' : '';
        const params = corpusType ? [corpusType] : [];
        const storedEmbeddings = db.prepare(`
          SELECT de.digest_id as id, de.embedding, d.corpus_type, d.title, d.summary_text, d.entities_json, d.references_json
          FROM digest_embeddings de
          JOIN archive_digests d ON de.digest_id = d.id
          WHERE d.is_deleted = 0 ${filterClause}
        `).all(...params);

        const scored = [];
        for (const item of storedEmbeddings) {
          const vec = embeddingService.bufferToFloat32(item.embedding);
          if (vec) {
            const sim = embeddingService.cosineSimilarity(queryVector, vec);
            if (sim > 0.22) {
              scored.push({ ...item, similarity: sim });
            }
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        vectorHits.push(...scored.slice(0, 15));
      } catch (err) {
        console.warn('[Digest Vector Search Warning]:', err.message);
      }
    }

    let topDigests = [];
    if (ftsHits.length === 0 && vectorHits.length === 0) {
      // Fallback: Return most recent active digests
      const filterClause = corpusType ? 'AND corpus_type = ?' : '';
      const params = corpusType ? [corpusType, limit] : [limit];
      topDigests = db.prepare(`
        SELECT id, corpus_type, title, summary_text, entities_json, references_json
        FROM archive_digests
        WHERE is_deleted = 0 ${filterClause}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...params);
    } else {
      topDigests = this.combineRRF([ftsHits, vectorHits]).slice(0, limit);
    }

    return topDigests.map(d => ({
      ...d,
      entities: (() => {
        try { return JSON.parse(d.entities_json || '[]'); } catch (_) { return []; }
      })(),
      references: (() => {
        try { return JSON.parse(d.references_json || '[]'); } catch (_) { return []; }
      })()
    }));
  }

  // -------------------------------------------------------------
  // Tier 2: Search Raw Archive Messages
  // -------------------------------------------------------------
  async searchMessages(query, queryVector = null, options = {}) {
    const { excludeMessageId = null, excludeConversationId = null, scopedCategoryIds = [], limit = 5 } = options;
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    const convClause = excludeConversationId ? 'AND m.conversation_id != ?' : '';
    const baseParams = excludeConversationId ? [excludeMessageId || '', excludeConversationId] : [excludeMessageId || ''];

    if (keywords.length > 0) {
      try {
        const andFts = keywords.map(w => `${w}*`).join(' AND ');
        let rows = db.prepare(`
          SELECT m.id, m.content, m.role, m.timestamp, m.conversation_id, c.title as conversation_title
          FROM messages_fts fts
          JOIN messages m ON fts.rowid = m.rowid
          JOIN conversations c ON m.conversation_id = c.id
          WHERE messages_fts MATCH ? AND m.id != ? ${convClause} AND m.is_deleted = 0
          ORDER BY m.timestamp DESC
          LIMIT 25
        `).all(andFts, ...baseParams);

        if (rows.length === 0 && keywords.length > 1) {
          const orFts = keywords.map(w => `${w}*`).join(' OR ');
          rows = db.prepare(`
            SELECT m.id, m.content, m.role, m.timestamp, m.conversation_id, c.title as conversation_title
            FROM messages_fts fts
            JOIN messages m ON fts.rowid = m.rowid
            JOIN conversations c ON m.conversation_id = c.id
            WHERE messages_fts MATCH ? AND m.id != ? ${convClause} AND m.is_deleted = 0
            ORDER BY m.timestamp DESC
            LIMIT 25
          `).all(orFts, ...baseParams);
        }

        ftsHits.push(...rows);
      } catch (err) {
        console.warn('[Messages FTS Search Warning]:', err.message);
      }
    }

    const vectorHits = [];
    if (queryVector) {
      try {
        const rows = db.prepare(`
          SELECT me.message_id as id, me.embedding, m.content, m.role, m.timestamp, m.conversation_id, c.title as conversation_title
          FROM message_embeddings me
          JOIN messages m ON me.message_id = m.id
          JOIN conversations c ON m.conversation_id = c.id
          WHERE m.id != ? ${convClause} AND m.is_deleted = 0
        `).all(...baseParams);

        const scored = [];
        for (const item of rows) {
          const vec = embeddingService.bufferToFloat32(item.embedding);
          if (vec) {
            const sim = embeddingService.cosineSimilarity(queryVector, vec);
            if (sim > 0.30) {
              scored.push({ ...item, similarity: sim });
            }
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        vectorHits.push(...scored.slice(0, 25));
      } catch (err) {
        console.warn('[Messages Vector Search Warning]:', err.message);
      }
    }

    if (ftsHits.length === 0 && vectorHits.length === 0) {
      return [];
    }

    const fused = this.combineRRF([ftsHits, vectorHits]);
    return fused.slice(0, limit);
  }

  // -------------------------------------------------------------
  // Tier 0: Pre-Search Offline Entity Index Lookup (O(1) Indexed)
  // -------------------------------------------------------------
  searchEntities(query, limit = 5) {
    if (!query) return [];
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const rawWords = cleanQuery.split(/\s+/).filter(w => w.length > 1);
    const keywords = rawWords.filter(w => !STOP_WORDS.has(w));
    if (keywords.length === 0) return [];

    const hits = [];
    const seenChunkIds = new Set();
    const seenNoteIds = new Set();
    const seenEntityIds = new Set();

    // 1. Contiguous phrase search (e.g. "mataus asato", "black crowes")
    const phrase = keywords.join(' ');
    const entityRows = db.prepare(`
      SELECT e.*, c.content as chunk_content, c.heading as chunk_heading,
             n.title as note_title, n.rel_path as note_rel_path, n.file_name as note_file_name,
             n.mtime_ms, n.created_at, n.updated_at
      FROM archive_entities e
      LEFT JOIN obsidian_chunks c ON e.chunk_id = c.id
      LEFT JOIN obsidian_notes n ON e.source_id = n.id
      WHERE e.normalized_name = ? OR e.normalized_name LIKE ?
      LIMIT 10
    `).all(phrase, `%${phrase}%`);

    for (const r of entityRows) {
      seenEntityIds.add(r.id);
    }

    // 2. Also search distinctive keywords (e.g. "asato") to catch variant spellings/mentions across entities
    if (keywords.length > 1) {
      for (const kw of keywords) {
        if (kw.length >= 4) {
          const rows = db.prepare(`
            SELECT e.*, c.content as chunk_content, c.heading as chunk_heading,
                   n.title as note_title, n.rel_path as note_rel_path, n.file_name as note_file_name,
                   n.mtime_ms, n.created_at, n.updated_at
            FROM archive_entities e
            LEFT JOIN obsidian_chunks c ON e.chunk_id = c.id
            LEFT JOIN obsidian_notes n ON e.source_id = n.id
            WHERE e.normalized_name LIKE ?
            LIMIT 5
          `).all(`%${kw}%`);
          for (const r of rows) {
            if (!seenEntityIds.has(r.id)) {
              seenEntityIds.add(r.id);
              entityRows.push(r);
            }
          }
        }
      }
    }

    for (const row of entityRows) {
      const isExactPhrase = phrase && row.normalized_name.includes(phrase);
      const score = isExactPhrase ? 2.5 : 2.0;

      if (row.chunk_id && !seenChunkIds.has(row.chunk_id)) {
        seenChunkIds.add(row.chunk_id);
        hits.push({
          id: row.chunk_id,
          chunk_id: row.chunk_id,
          note_id: row.source_id,
          title: row.note_title || row.name,
          rel_path: row.note_rel_path || row.source_ref,
          content: row.chunk_content || row.context_snippet,
          heading: row.chunk_heading,
          entityName: row.name,
          source_type: row.source_type,
          mtime_ms: row.mtime_ms,
          created_at: row.created_at,
          updated_at: row.updated_at,
          isEntityMatch: true,
          rrfScore: score
        });
      } else if (row.source_type === 'obsidian_note' && !seenNoteIds.has(row.source_id)) {
        seenNoteIds.add(row.source_id);
        hits.push({
          id: row.source_id,
          note_id: row.source_id,
          title: row.note_title || row.name,
          rel_path: row.note_rel_path || row.source_ref,
          content: row.context_snippet,
          entityName: row.name,
          source_type: row.source_type,
          mtime_ms: row.mtime_ms,
          created_at: row.created_at,
          updated_at: row.updated_at,
          isEntityMatch: true,
          rrfScore: score
        });
      }
    }

    return hits.slice(0, limit);
  }

  // -------------------------------------------------------------
  // Search Obsidian Chunks (Atomic Sections: FTS5 + Vectors)
  // -------------------------------------------------------------
  async searchObsidianChunks(query, queryVector = null, limit = 5) {
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const andFts = keywords.map(w => `${w}*`).join(' AND ');
        const andRows = db.prepare(`
          SELECT c.id, c.note_id, c.chunk_index, c.heading, c.start_char, c.end_char, c.content,
                 n.file_name, n.rel_path, n.title, n.mtime_ms, n.created_at, n.updated_at
          FROM obsidian_chunks_fts fts
          JOIN obsidian_chunks c ON fts.rowid = c.rowid
          JOIN obsidian_notes n ON c.note_id = n.id
          WHERE obsidian_chunks_fts MATCH ?
          ORDER BY rank
          LIMIT 25
        `).all(andFts);

        let orRows = [];
        if (keywords.length > 1) {
          const orFts = keywords.map(w => `${w}*`).join(' OR ');
          orRows = db.prepare(`
            SELECT c.id, c.note_id, c.chunk_index, c.heading, c.start_char, c.end_char, c.content,
                   n.file_name, n.rel_path, n.title, n.mtime_ms, n.created_at, n.updated_at
            FROM obsidian_chunks_fts fts
            JOIN obsidian_chunks c ON fts.rowid = c.rowid
            JOIN obsidian_notes n ON c.note_id = n.id
            WHERE obsidian_chunks_fts MATCH ?
            ORDER BY rank
            LIMIT 25
          `).all(orFts);
        }

        // Fuse AND matches (weight 3.0) with OR matches (weight 1.5)
        ftsHits.push(...this.combineRRF([andRows, orRows], 60, [3.0, 1.5]));
      } catch (err) {
        console.warn('[Obsidian Chunks FTS Warning]:', err.message);
      }
    }

    const vectorHits = [];
    if (queryVector) {
      try {
        const rows = db.prepare(`
          SELECT ce.chunk_id as id, ce.embedding, c.note_id, c.chunk_index, c.heading, c.start_char, c.end_char, c.content,
                 n.file_name, n.rel_path, n.title, n.mtime_ms, n.created_at, n.updated_at
          FROM obsidian_chunk_embeddings ce
          JOIN obsidian_chunks c ON ce.chunk_id = c.id
          JOIN obsidian_notes n ON c.note_id = n.id
        `).all();

        const scored = [];
        for (const item of rows) {
          const vec = embeddingService.bufferToFloat32(item.embedding);
          if (vec) {
            const sim = embeddingService.cosineSimilarity(queryVector, vec);
            if (sim > 0.30) {
              scored.push({ ...item, similarity: sim });
            }
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        vectorHits.push(...scored.slice(0, 25));
      } catch (err) {
        console.warn('[Obsidian Chunk Vector Warning]:', err.message);
      }
    }

    if (ftsHits.length === 0 && vectorHits.length === 0) {
      return [];
    }

    const fused = this.combineRRF([ftsHits, vectorHits], 60, [2.5, 1.0]);
    return fused.slice(0, limit);
  }

  // -------------------------------------------------------------
  // Search Obsidian Notes (Hybrid Chunks + Whole Notes + RRF)
  // -------------------------------------------------------------
  async searchObsidianNotes(query, queryVector = null, limit = 5) {
    const keywords = this.extractKeywords(query);

    // 1. Search atomic chunks first for high-granularity hits
    const chunkHits = await this.searchObsidianChunks(query, queryVector, limit);

    // 2. Search note-level FTS & embeddings as fallback/complement
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const andFts = keywords.map(w => `${w}*`).join(' AND ');
        let rows = db.prepare(`
          SELECT n.id, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.created_at, n.updated_at
          FROM obsidian_notes_fts fts
          JOIN obsidian_notes n ON fts.rowid = n.rowid
          WHERE obsidian_notes_fts MATCH ?
          ORDER BY rank
          LIMIT 25
        `).all(andFts);

        if (rows.length === 0 && keywords.length > 1) {
          const orFts = keywords.map(w => `${w}*`).join(' OR ');
          rows = db.prepare(`
            SELECT n.id, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.created_at, n.updated_at
            FROM obsidian_notes_fts fts
            JOIN obsidian_notes n ON fts.rowid = n.rowid
            WHERE obsidian_notes_fts MATCH ?
            ORDER BY rank
            LIMIT 25
          `).all(orFts);
        }

        ftsHits.push(...rows);
      } catch (err) {
        console.warn('[Obsidian FTS Warning]:', err.message);
      }
    }

    const vectorHits = [];
    if (queryVector) {
      try {
        const rows = db.prepare(`
          SELECT ne.note_id as id, ne.embedding, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.created_at, n.updated_at
          FROM obsidian_note_embeddings ne
          JOIN obsidian_notes n ON ne.note_id = n.id
        `).all();

        const scored = [];
        for (const item of rows) {
          const vec = embeddingService.bufferToFloat32(item.embedding);
          if (vec) {
            const sim = embeddingService.cosineSimilarity(queryVector, vec);
            if (sim > 0.35) {
              scored.push({ ...item, similarity: sim });
            }
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        vectorHits.push(...scored.slice(0, 25));
      } catch (err) {
        console.warn('[Obsidian Vector Warning]:', err.message);
      }
    }

    const noteHits = this.combineRRF([ftsHits, vectorHits], 60, [2.0, 1.0]);

    // Merge: chunks take precedence for precision
    const combined = [];
    const seenChunkIds = new Set();

    for (const chunk of chunkHits) {
      if (!seenChunkIds.has(chunk.id)) {
        seenChunkIds.add(chunk.id);
        combined.push({
          ...chunk,
          id: chunk.note_id || chunk.id,
          chunk_id: chunk.id,
          preview: this.extractCenteredSnippet(chunk.content, keywords, 220)
        });
      }
    }

    const seenNoteIds = new Set(combined.map(c => c.id));
    for (const note of noteHits) {
      if (!seenNoteIds.has(note.id)) {
        seenNoteIds.add(note.id);
        combined.push({
          ...note,
          preview: this.extractCenteredSnippet(note.content, keywords, 220)
        });
      }
    }

    return combined.slice(0, limit);
  }

  // -------------------------------------------------------------
  // Complete Hierarchical Context Assembly with Strict Token Budget
  // -------------------------------------------------------------
  async assembleContext(query, options = {}) {
    const { excludeMessageId = null, excludeConversationId = null, maxTotalChars = 7500 } = options;
    const keywords = this.extractKeywords(query);
    const lowerQuery = (query || '').toLowerCase();
    const isNegatingObsidian = /non[\s-]obsidian|not[\s-]obsidian|without[\s-]obsidian|except[\s-]obsidian|no[\s-]obsidian/.test(lowerQuery);
    const isObsidianFocused = !isNegatingObsidian && /obsidian|note|notes|vault|journal|log|markdown|document|diary/.test(lowerQuery);

    // 0. Search Tier 0: Pre-search Entity & Chunk Lookup
    const entityHits = this.searchEntities(query, 3);

    // 1. Fetch query vector (if local embedding model available)
    let queryVector = null;
    try {
      queryVector = await embeddingService.getVector(query);
    } catch (_) {}

    // 2. Search Tier 1: Dual-Corpus Digests & Summaries
    const digests = await this.searchDigests(query, queryVector, 3);

    // Extract exact provenance links from winning Tier 1 digests
    const linkedConvIds = new Set();
    const linkedNoteIds = new Set();
    const linkedNotePaths = new Set();

    for (const d of digests) {
      for (const ref of (d.references || [])) {
        if (ref.type === 'conversation' && ref.id) {
          linkedConvIds.add(ref.id);
        } else if (ref.type === 'obsidian_note') {
          if (ref.id) linkedNoteIds.add(ref.id);
          if (ref.rel_path) linkedNotePaths.add(ref.rel_path);
        }
      }
    }

    // 3. Search Tier 2: Obsidian Notes & Chunks
    let obsidianHits = await this.searchObsidianNotes(query, queryVector, isObsidianFocused ? 5 : 3);

    // Track both chunk IDs and note IDs seen in obsidianHits
    const seenChunkIds = new Set();
    const seenNoteIds = new Set();
    for (const h of obsidianHits) {
      if (h.chunk_id) seenChunkIds.add(h.chunk_id);
      const nId = h.note_id || (h.chunk_id ? null : h.id);
      if (nId) seenNoteIds.add(nId);
    }

    // Inject entityHits at the top of obsidianHits if not already present
    if (entityHits.length > 0) {
      for (const ent of entityHits) {
        const chunkMatch = ent.chunk_id && seenChunkIds.has(ent.chunk_id);
        const noteMatch = !ent.chunk_id && (ent.note_id || ent.id) && seenNoteIds.has(ent.note_id || ent.id);
        if (!chunkMatch && !noteMatch) {
          obsidianHits.unshift(ent);
          if (ent.chunk_id) seenChunkIds.add(ent.chunk_id);
          const nId = ent.note_id || ent.id;
          if (nId) seenNoteIds.add(nId);
        }
      }
    }

    // If Tier 1 found linked notes not in search hits, append them as supplementary context
    if (linkedNoteIds.size > 0 || linkedNotePaths.size > 0) {
      for (const noteId of linkedNoteIds) {
        if (!seenNoteIds.has(noteId)) {
          const note = obsidianSync.getNoteById(noteId);
          if (note) {
            obsidianHits.push(note);
            seenNoteIds.add(noteId);
          }
        }
      }
      for (const notePath of linkedNotePaths) {
        const note = obsidianSync.getNoteByPath ? obsidianSync.getNoteByPath(notePath) : null;
        if (note && !seenNoteIds.has(note.id)) {
          obsidianHits.push(note);
          seenNoteIds.add(note.id);
        }
      }
    }

    // 4. Search Tier 2: Raw Messages (prioritizing provenance-linked conversations)
    let messages = await this.searchMessages(query, queryVector, {
      excludeMessageId,
      excludeConversationId,
      limit: isObsidianFocused ? 3 : 5
    });

    if (linkedConvIds.size > 0) {
      const existingMsgIds = new Set(messages.map(m => m.id));
      const placeholders = Array.from(linkedConvIds).map(() => '?').join(',');
      try {
        const linkedMessages = db.prepare(`
          SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.title as conversation_title
          FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
          WHERE m.conversation_id IN (${placeholders}) AND m.is_deleted = 0
          ORDER BY m.timestamp DESC
          LIMIT 4
        `).all(...Array.from(linkedConvIds));

        for (const lm of linkedMessages) {
          if (!existingMsgIds.has(lm.id)) {
            messages.unshift(lm);
            existingMsgIds.add(lm.id);
          }
        }
      } catch (err) {
        console.warn('[HybridSearch] Failed to fetch linked messages:', err.message);
      }
    }

    // 5. Context Budget Allocator
    // Ceiling: ~7,500 chars (~1,800 - 2,000 tokens)
    const contextSections = [];
    let budgetRemaining = maxTotalChars;

    // A. Build Obsidian Section
    const buildObsidianSection = () => {
      if (obsidianHits.length === 0) return null;
      const noteLines = [];
      const noteBudget = isObsidianFocused ? Math.min(3800, budgetRemaining) : Math.min(2600, budgetRemaining);
      let consumed = 0;

      for (const n of obsidianHits) {
        if (consumed >= noteBudget) break;
        let rawContent = n.content || '';
        if (!rawContent && n.id) {
          const fullNote = obsidianSync.getNoteById(n.id);
          rawContent = fullNote?.content || '';
        }
        const maxSnippet = Math.min(1000, noteBudget - consumed);
        const snippet = this.extractCenteredSnippet(rawContent, keywords, maxSnippet);
        const noteTime = n.created_at || n.updated_at || (n.mtime_ms ? new Date(n.mtime_ms).toISOString() : '');
        const headingStr = n.heading && n.heading !== 'Document' ? ` > ${n.heading}` : '';
        const entityTag = n.isEntityMatch ? ` [Entity: ${n.entityName}]` : '';
        const line = `[Obsidian Note: "${n.title || n.file_name}"${headingStr}] (${n.rel_path})${entityTag}${noteTime ? ` [Date: ${noteTime}]` : ''}:\n${snippet}`;
        noteLines.push(line);
        consumed += line.length;
      }
      budgetRemaining -= consumed;
      return noteLines.length > 0 ? `### Relevant Obsidian Vault Notes:\n` + noteLines.join('\n\n') : null;
    };

    // B. Build Digests Section (AI Search Map)
    const buildDigestsSection = () => {
      if (digests.length === 0 || budgetRemaining < 400) return null;
      const digestLines = [];
      const digestBudget = Math.min(2000, budgetRemaining);
      let consumed = 0;

      for (const d of digests) {
        if (consumed >= digestBudget) break;
        const maxSnippet = Math.min(800, digestBudget - consumed);
        const snippet = d.summary_text.length > maxSnippet 
          ? d.summary_text.slice(0, maxSnippet) + '... [truncated]' 
          : d.summary_text;
        const corpusLabel = d.corpus_type === 'obsidian_notes' ? 'Obsidian Vault Digest' : 'AI Conversations Digest';
        const entitiesLine = d.entities && d.entities.length > 0 ? `Entities: ${d.entities.join(', ')}\n` : '';
        const line = `[${corpusLabel}: "${d.title}"]:\n${entitiesLine}${snippet}`;
        digestLines.push(line);
        consumed += line.length;
      }
      budgetRemaining -= consumed;
      return digestLines.length > 0 ? `### Relevant Archive Digests & Topic Index:\n` + digestLines.join('\n\n') : null;
    };

    // C. Build Messages Section
    const buildMessagesSection = () => {
      if (messages.length === 0 || budgetRemaining < 400) return null;
      const msgLines = [];
      const msgBudget = Math.min(3200, budgetRemaining);
      let consumed = 0;

      for (const m of messages) {
        if (consumed >= msgBudget) break;
        const maxSnippet = Math.min(750, msgBudget - consumed);
        const snippet = this.extractCenteredSnippet(m.content, keywords, maxSnippet);
        const ts = m.timestamp ? ` [${m.timestamp}]` : '';
        const line = `[Conversation: "${m.conversation_title}"] (${m.role})${ts}:\n${snippet}`;
        msgLines.push(line);
        consumed += line.length;
      }
      budgetRemaining -= consumed;
      return msgLines.length > 0 ? `### Relevant Historical Messages:\n` + msgLines.join('\n\n') : null;
    };

    if (isObsidianFocused) {
      const obsSec = buildObsidianSection();
      if (obsSec) contextSections.push(obsSec);
      const digSec = buildDigestsSection();
      if (digSec) contextSections.push(digSec);
      const msgSec = buildMessagesSection();
      if (msgSec) contextSections.push(msgSec);
    } else {
      const digSec = buildDigestsSection();
      if (digSec) contextSections.push(digSec);
      const obsSec = buildObsidianSection();
      if (obsSec) contextSections.push(obsSec);
      const msgSec = buildMessagesSection();
      if (msgSec) contextSections.push(msgSec);
    }

    return {
      contextText: contextSections.join('\n\n'),
      digestsCount: digests.length,
      messagesCount: messages.length,
      obsidianCount: obsidianHits.length,
      hybridUsed: !!queryVector
    };
  }
}

module.exports = new HybridSearchEngine();
