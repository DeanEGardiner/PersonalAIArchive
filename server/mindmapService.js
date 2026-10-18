const { db } = require('./db');
const hybridSearch = require('./hybridSearch');
const embeddingService = require('./embeddingService');

class MindMapService {
  /**
   * Extract frontmatter tags and inline markdown #tags from note content
   */
  extractTags(text) {
    if (!text || typeof text !== 'string') return [];
    const tags = new Set();

    // 1. YAML frontmatter tags
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const tagsBlockMatch = fm.match(/(?:^|\n)\s*(?:tags?|categories)\s*:\s*([^\r\n]*)/i);
      if (tagsBlockMatch) {
        const lineVal = tagsBlockMatch[1].trim();
        if (lineVal) {
          const cleanVals = lineVal.replace(/[\[\]'"]/g, '').split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
          for (const t of cleanVals) {
            const clean = t.replace(/^#/, '');
            if (clean.length > 1 && !/^[-_]+$/.test(clean)) tags.add(clean);
          }
        }
        const afterTags = fm.slice(tagsBlockMatch.index + tagsBlockMatch[0].length);
        const listRegex = /^\s*-\s+([^\r\n#]+)/gm;
        let lm;
        while ((lm = listRegex.exec(afterTags)) !== null) {
          const before = afterTags.slice(0, lm.index);
          if (/(?:^|\n)[a-zA-Z0-9_-]+:/.test(before)) break;
          const tagVal = lm[1].trim().replace(/^['"]|['"]$/g, '');
          if (tagVal && tagVal.length > 1 && !/^[-_]+$/.test(tagVal)) {
            tags.add(tagVal.replace(/^#/, ''));
          }
        }
      }
    }

    // 2. Inline #tags
    const tagRegex = /(?:^|\s)#([a-zA-Z0-9_\-\/]{2,30})\b/g;
    let m;
    while ((m = tagRegex.exec(text)) !== null) {
      const t = m[1].trim();
      if (t.length > 1 && !/^[-_]+$/.test(t)) {
        tags.add(t);
      }
    }

    return Array.from(tags);
  }

  /**
   * Extract wikilinks [[Target Note]] from text
   */
  extractWikilinks(text) {
    if (!text || typeof text !== 'string') return [];
    const links = new Set();
    const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = wikiRegex.exec(text)) !== null) {
      const raw = m[1].trim();
      if (raw && raw.length > 1 && !raw.startsWith('20') && raw.length < 50) {
        links.add(raw);
      }
    }
    return Array.from(links);
  }

  /**
   * Get all tags with their note counts across the entire Obsidian vault
   */
  getAllVaultTags() {
    const notes = db.prepare('SELECT id, content FROM obsidian_notes').all();
    const tagCounts = {};
    for (const n of notes) {
      for (const t of this.extractTags(n.content)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    return Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Search non-deleted conversations by title or message content
   */
  searchConversations(query, limit = 5) {
    if (!query || !query.trim()) return [];
    const cleanQ = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const words = cleanQ.split(/\s+/).filter(w => w.length > 1);
    const convMap = new Map();

    // 1. Title matches
    try {
      const titleMatches = db.prepare(`
        SELECT c.id, c.title, c.default_provider as provider, c.default_model as model, c.updated_at, c.created_at,
               (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0) as msg_count,
               (SELECT substr(m.content, 1, 260) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0 ORDER BY m.timestamp ASC LIMIT 1) as preview
        FROM conversations c
        WHERE c.is_deleted = 0 AND lower(c.title) LIKE ?
        LIMIT ?
      `).all(`%${cleanQ}%`, limit);

      for (const c of titleMatches) {
        if (c.msg_count > 0 || c.title !== 'New Conversation') {
          convMap.set(c.id, { ...c, score: 60 });
        }
      }
    } catch (_) {}

    // 2. FTS messages match
    if (words.length > 0) {
      try {
        const andExpr = words.map(w => `${w}*`).join(' AND ');
        const msgMatches = db.prepare(`
          SELECT c.id, c.title, c.default_provider as provider, c.default_model as model, c.updated_at, c.created_at,
                 (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0) as msg_count,
                 substr(m.content, 1, 260) as preview
          FROM messages_fts fts
          JOIN messages m ON fts.rowid = m.rowid
          JOIN conversations c ON m.conversation_id = c.id
          WHERE messages_fts MATCH ? AND m.is_deleted = 0 AND c.is_deleted = 0
          LIMIT ?
        `).all(andExpr, limit);

        for (const m of msgMatches) {
          if (!convMap.has(m.id)) {
            convMap.set(m.id, { ...m, score: 35 });
          }
        }
      } catch (_) {}
    }

    return Array.from(convMap.values()).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Get active recent conversations with messages
   */
  getRecentConversations(limit = 6) {
    try {
      return db.prepare(`
        SELECT c.id, c.title, c.default_provider as provider, c.default_model as model, c.updated_at, c.created_at,
               (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0) as msg_count,
               (SELECT substr(m.content, 1, 260) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0 ORDER BY m.timestamp ASC LIMIT 1) as preview
        FROM conversations c
        WHERE c.is_deleted = 0 AND (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.is_deleted = 0) > 0
        ORDER BY c.updated_at DESC
        LIMIT ?
      `).all(limit);
    } catch (_) {
      return [];
    }
  }

  /**
   * Build complete force-graph topology centered on a query term or top tags
   */
  async buildGraph(query = '', options = {}) {
    const { maxNodes = 45 } = options;
    const cleanQuery = (query || '').trim();
    const isGlobal = !cleanQuery;

    const allNotes = db.prepare(`
      SELECT id, file_name, rel_path, title, substr(content, 1, 350) as preview, content, mtime_ms, created_at, updated_at
      FROM obsidian_notes
      ORDER BY created_at DESC
    `).all();

    const noteTagMap = new Map();
    const noteWikiMap = new Map();
    const globalTagCounts = new Map();

    for (const note of allNotes) {
      const tags = this.extractTags(note.content);
      const wikilinks = this.extractWikilinks(note.content);
      noteTagMap.set(note.id, tags);
      noteWikiMap.set(note.id, wikilinks);

      for (const t of tags) {
        globalTagCounts.set(t, (globalTagCounts.get(t) || 0) + 1);
      }
    }

    const availableTags = Array.from(globalTagCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const nodesMap = new Map();
    const edgesMap = new Map();

    const addNode = (node) => {
      if (!nodesMap.has(node.id)) {
        nodesMap.set(node.id, node);
      }
    };

    const addLink = (source, target, type, weight = 1.0) => {
      if (source === target) return;
      const key = `${source}:::${target}`;
      const revKey = `${target}:::${source}`;
      if (!edgesMap.has(key) && !edgesMap.has(revKey)) {
        edgesMap.set(key, { source, target, type, weight });
      }
    };

    // ---------------------------------------------------------
    // Scenario A: Global Mind Map (No Query Provided)
    // ---------------------------------------------------------
    if (isGlobal) {
      const rootId = 'root:vault';
      const recentConvs = this.getRecentConversations(5);

      addNode({
        id: rootId,
        label: 'Knowledge Archive',
        sublabel: `${allNotes.length} Notes · ${recentConvs.length} Active Dialogues`,
        type: 'query',
        size: 36,
        color: '#a855f7',
        isRoot: true,
        preview: 'Unified knowledge hub synthesizing Obsidian notes, tags, and AI Archive conversations.'
      });

      // Select top 8 most prominent tags
      const topTags = availableTags.slice(0, 8);
      for (const t of topTags) {
        const tagNodeId = `tag:${t.name}`;
        addNode({
          id: tagNodeId,
          label: `#${t.name}`,
          type: 'tag',
          tagName: t.name,
          count: t.count,
          size: Math.min(28, 16 + Math.log2(t.count + 1) * 4),
          color: '#06b6d4',
          preview: `Tag #${t.name} referenced across ${t.count} Obsidian notes.`
        });
        addLink(rootId, tagNodeId, 'root_tag', 2.5);

        // Find up to 4 notes containing this tag
        const taggedNotes = allNotes.filter(n => (noteTagMap.get(n.id) || []).includes(t.name)).slice(0, 4);
        for (const note of taggedNotes) {
          const noteNodeId = `note:${note.id}`;
          addNode({
            id: noteNodeId,
            label: note.title,
            type: 'note',
            noteId: note.id,
            rel_path: note.rel_path,
            date: note.created_at || note.updated_at,
            size: 18,
            color: '#ec4899',
            preview: note.preview,
            tags: noteTagMap.get(note.id) || []
          });
          addLink(tagNodeId, noteNodeId, 'tag_note', 1.5);

          // Add 1 wikilink if note has references
          const wikis = noteWikiMap.get(note.id) || [];
          if (wikis.length > 0) {
            const wName = wikis[0];
            const wikiNodeId = `wiki:${wName}`;
            addNode({
              id: wikiNodeId,
              label: `[[${wName}]]`,
              type: 'wikilink',
              name: wName,
              size: 14,
              color: '#f59e0b',
              preview: `Obsidian wikilink reference to [[${wName}]].`
            });
            addLink(noteNodeId, wikiNodeId, 'note_wiki', 1.0);
          }
        }
      }

      // Add Recent Active AI Conversations (Cross-system)
      for (const c of recentConvs) {
        const convNodeId = `conv:${c.id}`;
        addNode({
          id: convNodeId,
          label: c.title || 'AI Dialogue',
          type: 'conversation',
          conversationId: c.id,
          msg_count: c.msg_count,
          provider: c.provider,
          model: c.model,
          size: 20,
          color: '#8b5cf6',
          preview: c.preview || `AI conversation with ${c.msg_count} messages.`,
          date: c.updated_at || c.created_at
        });
        addLink(rootId, convNodeId, 'root_conversation', 1.8);
      }

      // Add recent AI Conversation Digests
      const recentDigests = db.prepare(`
        SELECT id, title, summary_text, corpus_type, updated_at 
        FROM archive_digests 
        WHERE is_deleted = 0 
        ORDER BY updated_at DESC LIMIT 3
      `).all();

      for (const d of recentDigests) {
        const dId = `digest:${d.id}`;
        addNode({
          id: dId,
          label: d.title,
          type: 'digest',
          corpus_type: d.corpus_type,
          size: 16,
          color: '#10b981',
          preview: d.summary_text.slice(0, 200),
          date: d.updated_at
        });
        addLink(rootId, dId, 'root_digest', 1.2);
      }

      return {
        rootId,
        query: '',
        stats: {
          nodesCount: nodesMap.size,
          linksCount: edgesMap.size,
          tagsCount: topTags.length,
          notesCount: allNotes.length,
          conversationsCount: recentConvs.length
        },
        nodes: Array.from(nodesMap.values()),
        links: Array.from(edgesMap.values()),
        availableTags
      };
    }

    // ---------------------------------------------------------
    // Scenario B: Exact Tag-Centered Mind Map (User centered on a Tag)
    // ---------------------------------------------------------
    const norm = (s) => (s || '').toLowerCase().replace(/^#/, '').replace(/[_\s-]+/g, '');
    const queryNorm = norm(cleanQuery);
    const matchedTag = availableTags.find(t => norm(t.name) === queryNorm);

    if (matchedTag) {
      const tagName = matchedTag.name;
      const rootId = `tag:${tagName}`;
      addNode({
        id: rootId,
        label: `#${tagName}`,
        sublabel: `${matchedTag.count} Linked Notes`,
        type: 'tag',
        tagName,
        count: matchedTag.count,
        size: 38,
        color: '#06b6d4',
        isRoot: true,
        preview: `Obsidian tag #${tagName} linked to ${matchedTag.count} notes across your vault.`
      });

      // 1st-Level Connections: ONLY notes that actually have this tag!
      const taggedNotes = allNotes.filter(n => {
        const tags = noteTagMap.get(n.id) || [];
        return tags.some(t => norm(t) === queryNorm);
      });

      for (const note of taggedNotes.slice(0, 24)) {
        const noteNodeId = `note:${note.id}`;
        const noteTags = noteTagMap.get(note.id) || [];
        const noteWikis = noteWikiMap.get(note.id) || [];

        addNode({
          id: noteNodeId,
          label: note.title,
          type: 'note',
          noteId: note.id,
          rel_path: note.rel_path,
          date: note.created_at || note.updated_at,
          size: 20,
          color: '#ec4899',
          preview: note.preview,
          tags: noteTags,
          wikilinks: noteWikis
        });

        // 1st LEVEL LINK: Tag -> Note (Direct 1st level connection)
        addLink(rootId, noteNodeId, 'tag_note', 2.5);

        // 2nd-Level Connections:
        // A. Secondary tags that appear on THIS note (linked to Note, NEVER to Root!)
        for (const otherTag of noteTags) {
          if (norm(otherTag) === queryNorm) continue;
          const otherTagNodeId = `tag:${otherTag}`;
          addNode({
            id: otherTagNodeId,
            label: `#${otherTag}`,
            type: 'tag',
            tagName: otherTag,
            count: globalTagCounts.get(otherTag) || 1,
            size: 16,
            color: '#38bdf8',
            preview: `Co-occurring tag #${otherTag} on note "${note.title}".`
          });
          // Note -> Other Tag (2nd level!)
          addLink(noteNodeId, otherTagNodeId, 'note_tag', 1.2);
        }

        // B. Wikilinks referenced inside THIS note (linked to Note, NEVER to Root!)
        for (const w of noteWikis.slice(0, 3)) {
          const wikiNodeId = `wiki:${w}`;
          addNode({
            id: wikiNodeId,
            label: `[[${w}]]`,
            type: 'wikilink',
            name: w,
            size: 14,
            color: '#f59e0b',
            preview: `Wikilink reference from note "${note.title}".`
          });
          // Note -> Wikilink (2nd level!)
          addLink(noteNodeId, wikiNodeId, 'note_wiki', 1.0);
        }
      }

      // Connect AI Conversations relevant to this topic or discussing tagged notes
      const topicConvs = this.searchConversations(tagName, 4);
      for (const conv of topicConvs) {
        const convNodeId = `conv:${conv.id}`;
        addNode({
          id: convNodeId,
          label: conv.title,
          type: 'conversation',
          conversationId: conv.id,
          msg_count: conv.msg_count,
          provider: conv.provider,
          model: conv.model,
          size: 19,
          color: '#8b5cf6',
          preview: conv.preview,
          date: conv.updated_at || conv.created_at
        });

        // If the conversation discusses one of the tagged notes, connect to that note!
        let linkedToNote = false;
        for (const note of taggedNotes) {
          if (conv.preview && conv.preview.toLowerCase().includes(note.title.toLowerCase())) {
            addLink(`note:${note.id}`, convNodeId, 'note_conversation', 1.5);
            linkedToNote = true;
            break;
          }
        }
        if (!linkedToNote) {
          addLink(rootId, convNodeId, 'tag_conversation', 1.6);
        }
      }

      // Relevant Archive Digests for this topic
      try {
        const digests = await hybridSearch.searchDigests(tagName, null, 2);
        for (const d of digests) {
          const dId = `digest:${d.id}`;
          addNode({
            id: dId,
            label: d.title,
            type: 'digest',
            corpus_type: d.corpus_type,
            size: 16,
            color: '#10b981',
            preview: d.summary_text.slice(0, 200),
            date: d.updated_at
          });
          addLink(rootId, dId, 'query_digest', 1.5);
        }
      } catch (_) {}

      return {
        rootId,
        query: cleanQuery,
        stats: {
          nodesCount: nodesMap.size,
          linksCount: edgesMap.size,
          tagsCount: 1,
          notesCount: taggedNotes.length,
          conversationsCount: topicConvs.length
        },
        nodes: Array.from(nodesMap.values()),
        links: Array.from(edgesMap.values()),
        availableTags
      };
    }

    // ---------------------------------------------------------
    // Scenario C: Term / Phrase Query (e.g. "Mateus Asato", "Sydney")
    // ---------------------------------------------------------
    const rootId = `query:${cleanQuery.toLowerCase()}`;
    addNode({
      id: rootId,
      label: cleanQuery,
      sublabel: 'Focus Concept',
      type: 'query',
      size: 38,
      color: '#eab308',
      isRoot: true,
      preview: `Mind map centered on "${cleanQuery}" prioritizing directly matching Obsidian notes, AI dialogues, and tags.`
    });

    const lowerQuery = cleanQuery.toLowerCase();
    const queryWords = lowerQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);

    // Precise scoring: Prioritize exact phrase or notes matching the query
    const scoredNotes = [];
    for (const note of allNotes) {
      let score = 0;
      const lowerTitle = (note.title || '').toLowerCase();
      const lowerContent = (note.content || '').toLowerCase();
      const tags = noteTagMap.get(note.id) || [];
      const wikis = noteWikiMap.get(note.id) || [];

      // Exact phrase matches
      if (lowerTitle === lowerQuery) score += 30;
      else if (lowerTitle.includes(lowerQuery)) score += 20;

      if (lowerContent.includes(lowerQuery)) score += 15;

      // Tag exact match
      const matchingTags = tags.filter(t => norm(t) === queryNorm || t.toLowerCase() === lowerQuery);
      if (matchingTags.length > 0) score += 25;

      // Wikilink exact match
      const matchingWikis = wikis.filter(w => w.toLowerCase() === lowerQuery);
      if (matchingWikis.length > 0) score += 18;

      // If multi-word phrase and not exact match, all words must be present to score
      if (queryWords.length > 1 && !lowerTitle.includes(lowerQuery) && !lowerContent.includes(lowerQuery)) {
        const allPresent = queryWords.every(w => lowerTitle.includes(w) || lowerContent.includes(w));
        if (allPresent) score += 8;
      } else if (queryWords.length === 1 && !lowerTitle.includes(lowerQuery) && !lowerContent.includes(lowerQuery)) {
        if (lowerTitle.includes(queryWords[0])) score += 5;
        else if (lowerContent.includes(queryWords[0])) score += 2;
      }

      if (score > 0) {
        scoredNotes.push({ note, score, tags, wikis });
      }
    }

    scoredNotes.sort((a, b) => b.score - a.score);
    const topScored = scoredNotes.slice(0, 16);

    // 1st-Level Connections: Directly Matched Notes link to Root!
    for (const item of topScored) {
      const note = item.note;
      const noteNodeId = `note:${note.id}`;

      addNode({
        id: noteNodeId,
        label: note.title,
        type: 'note',
        noteId: note.id,
        rel_path: note.rel_path,
        date: note.created_at || note.updated_at,
        size: Math.min(24, 16 + Math.log2(item.score + 1) * 2),
        color: '#ec4899',
        preview: note.preview,
        tags: item.tags,
        wikilinks: item.wikis
      });

      // Direct link from query center to note! (1st Level)
      addLink(rootId, noteNodeId, 'query_note', 2.0);

      // 2nd-Level Connections:
      // A. Tags belonging to THIS note link to the note, NOT to the root!
      for (const t of item.tags) {
        const tagNodeId = `tag:${t}`;
        addNode({
          id: tagNodeId,
          label: `#${t}`,
          type: 'tag',
          tagName: t,
          count: globalTagCounts.get(t) || 1,
          size: 16,
          color: '#06b6d4',
          preview: `Tag #${t} attached to note "${note.title}".`
        });
        // Note -> Tag (2nd level!)
        addLink(noteNodeId, tagNodeId, 'note_tag', 1.2);
      }

      // B. Wikilinks from THIS note link to the note
      for (const w of item.wikis.slice(0, 2)) {
        const wikiNodeId = `wiki:${w}`;
        addNode({
          id: wikiNodeId,
          label: `[[${w}]]`,
          type: 'wikilink',
          name: w,
          size: 14,
          color: '#f59e0b',
          preview: `Wikilink reference from note "${note.title}".`
        });
        addLink(noteNodeId, wikiNodeId, 'note_wiki', 1.0);
      }
    }

    // Connect Directly Matching AI Conversations (1st Level)
    const matchedConvs = this.searchConversations(cleanQuery, 5);
    for (const conv of matchedConvs) {
      const convNodeId = `conv:${conv.id}`;
      addNode({
        id: convNodeId,
        label: conv.title,
        type: 'conversation',
        conversationId: conv.id,
        msg_count: conv.msg_count,
        provider: conv.provider,
        model: conv.model,
        size: 20,
        color: '#8b5cf6',
        preview: conv.preview,
        date: conv.updated_at || conv.created_at
      });
      // Direct 1st-level link from query center to conversation
      addLink(rootId, convNodeId, 'query_conversation', 2.0);

      // Connect conversation to any note it specifically mentions
      for (const item of topScored) {
        if (conv.preview && conv.preview.toLowerCase().includes(item.note.title.toLowerCase())) {
          addLink(`note:${item.note.id}`, convNodeId, 'note_conversation', 1.3);
        }
      }
    }

    // Direct link to Archive Digests if relevant
    try {
      const digests = await hybridSearch.searchDigests(cleanQuery, null, 2);
      for (const d of digests) {
        const dId = `digest:${d.id}`;
        addNode({
          id: dId,
          label: d.title,
          type: 'digest',
          corpus_type: d.corpus_type,
          size: 16,
          color: '#10b981',
          preview: d.summary_text.slice(0, 200),
          date: d.updated_at
        });
        addLink(rootId, dId, 'query_digest', 1.5);
      }
    } catch (_) {}

    return {
      rootId,
      query: cleanQuery,
      stats: {
        nodesCount: nodesMap.size,
        linksCount: edgesMap.size,
        tagsCount: new Set(topScored.flatMap(i => i.tags)).size,
        notesCount: topScored.length,
        conversationsCount: matchedConvs.length
      },
      nodes: Array.from(nodesMap.values()),
      links: Array.from(edgesMap.values()),
      availableTags
    };
  }
}

module.exports = new MindMapService();
