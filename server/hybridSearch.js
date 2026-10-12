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
  'search', 'query', 'show', 'give', 'details', 'information', 'tell', 'me'
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

  // Reciprocal Rank Fusion (RRF): score = 1 / (k + rank)
  combineRRF(rankedLists, k = 60) {
    const scores = new Map();
    const itemMap = new Map();

    for (const list of rankedLists) {
      if (!Array.isArray(list)) continue;
      list.forEach((item, index) => {
        if (!item || !item.id) return;
        const currentScore = scores.get(item.id) || 0;
        scores.set(item.id, currentScore + (1 / (k + index + 1)));
        if (!itemMap.has(item.id)) {
          itemMap.set(item.id, item);
        }
      });
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, score]) => ({
        ...itemMap.get(id),
        rrfScore: score
      }));
  }

  // Smart snippet window centered around matching query terms
  extractCenteredSnippet(content, keywords = [], maxChars = 800) {
    if (!content) return '';
    if (content.length <= maxChars) return content;

    let bestPos = -1;
    const lower = content.toLowerCase();

    for (const kw of keywords) {
      const pos = lower.indexOf(kw.toLowerCase());
      if (pos !== -1) {
        bestPos = pos;
        break;
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

    let snippet = content.slice(start, end);
    if (start > 0) snippet = '... ' + snippet;
    if (end < content.length) snippet = snippet + ' ... [truncated]';

    return snippet;
  }

  // -------------------------------------------------------------
  // Tier 1: Search Archive Summaries & Category Digests
  // -------------------------------------------------------------
  async searchDigests(query, queryVector = null, limit = 2) {
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const ftsQuery = keywords.map(k => `${k}*`).join(' OR ');
        const rows = db.prepare(`
          SELECT s.id, s.summary_text, s.summary_type, s.category_id, c.name as category_name
          FROM archive_summaries_fts fts
          JOIN archive_summaries s ON fts.rowid = s.rowid
          LEFT JOIN categories c ON s.category_id = c.id
          WHERE archive_summaries_fts MATCH ? AND s.is_deleted = 0
          LIMIT 10
        `).all(ftsQuery);
        ftsHits.push(...rows);
      } catch (err) {
        console.warn('[Digest FTS Warning]:', err.message);
      }
    }

    const vectorHits = [];
    if (queryVector) {
      try {
        const storedEmbeddings = db.prepare(`
          SELECT se.summary_id as id, se.embedding, s.summary_text, s.summary_type, s.category_id, c.name as category_name
          FROM summary_embeddings se
          JOIN archive_summaries s ON se.summary_id = s.id
          LEFT JOIN categories c ON s.category_id = c.id
          WHERE s.is_deleted = 0
        `).all();

        const scored = [];
        for (const item of storedEmbeddings) {
          const vec = embeddingService.bufferToFloat32(item.embedding);
          if (vec) {
            const sim = embeddingService.cosineSimilarity(queryVector, vec);
            if (sim > 0.25) {
              scored.push({ ...item, similarity: sim });
            }
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);
        vectorHits.push(...scored.slice(0, 10));
      } catch (err) {
        console.warn('[Digest Vector Search Warning]:', err.message);
      }
    }

    if (ftsHits.length === 0 && vectorHits.length === 0) {
      // Fallback: Return most recent active summaries
      return db.prepare(`
        SELECT s.id, s.summary_text, s.summary_type, s.category_id, c.name as category_name
        FROM archive_summaries s
        LEFT JOIN categories c ON s.category_id = c.id
        WHERE s.is_deleted = 0
        ORDER BY s.updated_at DESC
        LIMIT ?
      `).all(limit);
    }

    return this.combineRRF([ftsHits, vectorHits]).slice(0, limit);
  }

  // -------------------------------------------------------------
  // Tier 2: Search Raw Archive Messages
  // -------------------------------------------------------------
  async searchMessages(query, queryVector = null, options = {}) {
    const { excludeMessageId = null, scopedCategoryIds = [], limit = 5 } = options;
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const andFts = keywords.map(w => `${w}*`).join(' AND ');
        let rows = db.prepare(`
          SELECT m.id, m.content, m.role, m.timestamp, m.conversation_id, c.title as conversation_title
          FROM messages_fts fts
          JOIN messages m ON fts.rowid = m.rowid
          JOIN conversations c ON m.conversation_id = c.id
          WHERE messages_fts MATCH ? AND m.id != ? AND m.is_deleted = 0
          ORDER BY m.timestamp DESC
          LIMIT 25
        `).all(andFts, excludeMessageId || '');

        if (rows.length === 0 && keywords.length > 1) {
          const orFts = keywords.map(w => `${w}*`).join(' OR ');
          rows = db.prepare(`
            SELECT m.id, m.content, m.role, m.timestamp, m.conversation_id, c.title as conversation_title
            FROM messages_fts fts
            JOIN messages m ON fts.rowid = m.rowid
            JOIN conversations c ON m.conversation_id = c.id
            WHERE messages_fts MATCH ? AND m.id != ? AND m.is_deleted = 0
            ORDER BY m.timestamp DESC
            LIMIT 25
          `).all(orFts, excludeMessageId || '');
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
          WHERE m.id != ? AND m.is_deleted = 0
        `).all(excludeMessageId || '');

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
  // Search Obsidian Notes (Hybrid: FTS5 + Vector Embeddings + RRF)
  // -------------------------------------------------------------
  async searchObsidianNotes(query, queryVector = null, limit = 5) {
    const keywords = this.extractKeywords(query);
    const ftsHits = [];

    if (keywords.length > 0) {
      try {
        const andFts = keywords.map(w => `${w}*`).join(' AND ');
        let rows = db.prepare(`
          SELECT n.id, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.updated_at
          FROM obsidian_notes_fts fts
          JOIN obsidian_notes n ON fts.rowid = n.rowid
          WHERE obsidian_notes_fts MATCH ?
          ORDER BY rank
          LIMIT 25
        `).all(andFts);

        if (rows.length === 0 && keywords.length > 1) {
          const orFts = keywords.map(w => `${w}*`).join(' OR ');
          rows = db.prepare(`
            SELECT n.id, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.updated_at
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
          SELECT ne.note_id as id, ne.embedding, n.file_name, n.rel_path, n.title, n.content, n.mtime_ms, n.updated_at
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

    if (ftsHits.length === 0 && vectorHits.length === 0) {
      return [];
    }

    const fused = this.combineRRF([ftsHits, vectorHits]);
    return fused.slice(0, limit);
  }

  // -------------------------------------------------------------
  // Complete Hierarchical Context Assembly with Strict Token Budget
  // -------------------------------------------------------------
  async assembleContext(query, options = {}) {
    const { excludeMessageId = null, maxTotalChars = 7500 } = options;
    const keywords = this.extractKeywords(query);
    const lowerQuery = (query || '').toLowerCase();
    const isObsidianFocused = /obsidian|note|notes|vault|journal|log|markdown|document|diary/.test(lowerQuery);

    // 1. Fetch query vector (if local embedding model available)
    let queryVector = null;
    try {
      queryVector = await embeddingService.getVector(query);
    } catch (_) {}

    // 2. Search Obsidian Notes (Hybrid)
    const obsidianHits = await this.searchObsidianNotes(query, queryVector, isObsidianFocused ? 5 : 3);

    // 3. Search Tier 1: Digests & Summaries
    const digests = await this.searchDigests(query, queryVector, 2);

    // 4. Search Tier 2: Raw Messages
    const messages = await this.searchMessages(query, queryVector, {
      excludeMessageId,
      limit: isObsidianFocused ? 3 : 5
    });

    // 5. Context Budget Allocator
    // Ceiling: ~7,500 chars (~1,800 - 2,000 tokens)
    const contextSections = [];
    let budgetRemaining = maxTotalChars;

    // A. If query is focused on Obsidian or found strong notes, inject Obsidian Notes first!
    const buildObsidianSection = () => {
      if (obsidianHits.length === 0) return null;
      const noteLines = [];
      const noteBudget = isObsidianFocused ? Math.min(3600, budgetRemaining) : Math.min(2400, budgetRemaining);
      let consumed = 0;

      for (const n of obsidianHits) {
        if (consumed >= noteBudget) break;
        const fullNote = obsidianSync.getNoteById(n.id);
        const rawContent = fullNote?.content || n.content || '';
        const maxSnippet = Math.min(900, noteBudget - consumed);
        const snippet = this.extractCenteredSnippet(rawContent, keywords, maxSnippet);
        const noteTime = n.updated_at || (n.mtime_ms ? new Date(n.mtime_ms).toISOString() : '');
        const line = `[Obsidian Note: "${n.title}"] (${n.rel_path})${noteTime ? ` [Updated: ${noteTime}]` : ''}:\n${snippet}`;
        noteLines.push(line);
        consumed += line.length;
      }
      budgetRemaining -= consumed;
      return noteLines.length > 0 ? `### Relevant Obsidian Vault Notes:\n` + noteLines.join('\n\n') : null;
    };

    // B. Build Digests Section
    const buildDigestsSection = () => {
      if (digests.length === 0 || budgetRemaining < 400) return null;
      const digestLines = [];
      const digestBudget = Math.min(1800, budgetRemaining);
      let consumed = 0;

      for (const d of digests) {
        if (consumed >= digestBudget) break;
        const maxSnippet = Math.min(800, digestBudget - consumed);
        const snippet = d.summary_text.length > maxSnippet 
          ? d.summary_text.slice(0, maxSnippet) + '... [truncated]' 
          : d.summary_text;
        const title = d.category_name ? `Thematic Digest: ${d.category_name}` : 'Global Archive Digest';
        digestLines.push(`[${title}]:\n${snippet}`);
        consumed += snippet.length;
      }
      budgetRemaining -= consumed;
      return digestLines.length > 0 ? `### Relevant Archive Digests & Themes:\n` + digestLines.join('\n\n') : null;
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
