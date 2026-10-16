const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, SUMMARIES_DIR } = require('./db');
const providerRouter = require('./providers');
const config = require('./config');
const embeddingService = require('./embeddingService');

class SummarizerService {
  constructor() {
    this.convSummariesDir = path.join(SUMMARIES_DIR, 'ai_conversations');
    this.obsidianSummariesDir = path.join(SUMMARIES_DIR, 'obsidian_notes');
    for (const dir of [this.convSummariesDir, this.obsidianSummariesDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  getSummarizerConfig() {
    const onlyPrivate = config.getSetting('only_private_ai_summarization') === 'true';
    let provider = config.getSetting('summarizer_provider') || 'ollama';
    let model = config.getSetting('summarizer_model') || config.DEFAULT_MODELS.ollama;

    if (onlyPrivate && !config.isLocalProvider(provider)) {
      provider = 'ollama';
    }

    return { onlyPrivate, provider, model };
  }

  resolveProviderAndModel(overrideProvider, overrideModel, apiKey) {
    const summarizerConfig = this.getSummarizerConfig();
    let provider = overrideProvider || summarizerConfig.provider;

    if (summarizerConfig.onlyPrivate && !config.isLocalProvider(provider)) {
      console.warn(`[Summarizer] Only private AI summarization is enabled. Forcing local provider instead of '${provider}'.`);
      provider = 'ollama';
    }

    let model = overrideModel || (provider === summarizerConfig.provider ? summarizerConfig.model : config.DEFAULT_MODELS[provider]);
    // Safety check: Never allow an embedding model to be used as a chat/summarizer model
    if (model && (model.toLowerCase().includes('embed') || model.toLowerCase().includes('bge-') || model.toLowerCase().includes('e5-'))) {
      if (provider === 'lmstudio') model = 'qwen/qwen3.8-27b';
      else if (provider === 'ollama') model = 'gemma4:12b-mlx';
      else if (provider === 'gemini') model = 'gemini-3.8-flash';
      else model = 'gpt-4o-mini';
    }
    const resolvedApiKey = apiKey || config.getApiKey(provider);

    return { provider, model, resolvedApiKey };
  }

  sanitizeEntities(rawEntities) {
    if (!Array.isArray(rawEntities)) return [];
    return rawEntities
      .map(e => (typeof e === 'string' ? e : (e?.name || e?.title || '')))
      .map(e => String(e || '').trim().replace(/^["'`]|["'`]$/g, ''))
      .filter(e => e.length >= 2 && e.length <= 80)
      .slice(0, 40);
  }

  sanitizeReferences(rawRefs, corpusType) {
    if (!Array.isArray(rawRefs)) return [];
    const validRefs = [];
    const checkConvStmt = db.prepare('SELECT id, title FROM conversations WHERE id = ? AND is_deleted = 0');
    const checkNoteStmt = db.prepare('SELECT id, title, rel_path FROM obsidian_notes WHERE id = ? OR rel_path = ?');

    for (const r of rawRefs) {
      if (!r || typeof r !== 'object') continue;
      const refId = typeof r.id === 'string' ? r.id.trim() : '';
      const refPath = typeof r.rel_path === 'string' ? r.rel_path.trim() : '';
      const refTitle = typeof r.title === 'string' ? r.title.trim() : '';

      if (corpusType === 'ai_conversations' || r.type === 'conversation') {
        const conv = refId ? checkConvStmt.get(refId) : null;
        if (conv) {
          validRefs.push({
            id: conv.id,
            title: refTitle || conv.title || 'Conversation',
            type: 'conversation'
          });
        }
      } else if (corpusType === 'obsidian_notes' || r.type === 'obsidian_note') {
        const note = (refId || refPath) ? checkNoteStmt.get(refId, refPath) : null;
        if (note) {
          validRefs.push({
            id: note.id,
            title: refTitle || note.title,
            rel_path: note.rel_path,
            type: 'obsidian_note'
          });
        }
      }
    }
    return validRefs;
  }

  cleanAndParseJson(rawText) {
    if (!rawText || !rawText.trim()) {
      throw new Error('AI provider returned an empty response.');
    }

    // Strip thinking tags
    let cleaned = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Strip markdown code fences if present
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch && fenceMatch[1]) {
      cleaned = fenceMatch[1].trim();
    }

    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    let startIdx = -1;
    let endIdx = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      startIdx = firstBrace;
      endIdx = cleaned.lastIndexOf('}');
    } else if (firstBracket !== -1) {
      startIdx = firstBracket;
      endIdx = cleaned.lastIndexOf(']');
    }

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      cleaned = cleaned.substring(startIdx, endIdx + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (_) {
      const withoutTrailingCommas = cleaned.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(withoutTrailingCommas);
    }
  }

  getPendingMessagesCount(mode = 'incremental') {
    if (mode === 'incremental') {
      const latestSummary = db.prepare(`
        SELECT MAX(coverage_end) as last_coverage 
        FROM archive_digests 
        WHERE corpus_type = 'ai_conversations' AND is_deleted = 0
      `).get();

      const lastTimestamp = latestSummary?.last_coverage || '1970-01-01T00:00:00';
      const count = db.prepare(`
        SELECT COUNT(*) as count FROM messages 
        WHERE timestamp > ? AND is_deleted = 0
      `).get(lastTimestamp);

      return { count: count.count, since: lastTimestamp };
    } else {
      const count = db.prepare(`
        SELECT COUNT(*) as count FROM messages WHERE is_deleted = 0
      `).get();
      return { count: count.count, since: null };
    }
  }

  getPendingCounts(mode = 'incremental') {
    const convPending = this.getPendingMessagesCount(mode);

    let obsidianCount = 0;
    if (mode === 'incremental') {
      const latestObsidianDigest = db.prepare(`
        SELECT MAX(updated_at) as last_updated
        FROM archive_digests
        WHERE corpus_type = 'obsidian_notes' AND is_deleted = 0
      `).get();
      const lastUpdated = latestObsidianDigest?.last_updated || '1970-01-01T00:00:00';
      obsidianCount = db.prepare(`
        SELECT COUNT(*) as count FROM obsidian_notes
        WHERE updated_at > ?
      `).get(lastUpdated)?.count || 0;
    } else {
      obsidianCount = db.prepare('SELECT COUNT(*) as count FROM obsidian_notes').get()?.count || 0;
    }

    return {
      ai_conversations: convPending,
      obsidian_notes: { count: obsidianCount }
    };
  }

  // --------------------------------------------------------------------------
  // Pipeline A: AI Conversations Digest (Search-First Indexing)
  // --------------------------------------------------------------------------
  async summarizeConversations({ mode = 'incremental', overrideProvider, overrideModel, apiKey }) {
    const { provider, model, resolvedApiKey } = this.resolveProviderAndModel(overrideProvider, overrideModel, apiKey);

    let messages = [];
    let coverageStart = null;
    let coverageEnd = null;

    if (mode === 'incremental') {
      const latestSummary = db.prepare(`
        SELECT MAX(coverage_end) as last_coverage 
        FROM archive_digests 
        WHERE corpus_type = 'ai_conversations' AND is_deleted = 0
      `).get();
      const lastTimestamp = latestSummary?.last_coverage || '1970-01-01T00:00:00';

      messages = db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.timestamp > ? AND m.is_deleted = 0
        ORDER BY m.timestamp ASC
        LIMIT 500
      `).all(lastTimestamp);
    } else {
      messages = db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.is_deleted = 0
        ORDER BY m.timestamp ASC
        LIMIT 1000
      `).all();
    }

    if (messages.length === 0) {
      return { success: true, corpus: 'ai_conversations', processedCount: 0, digestsCount: 0, message: 'No new messages to summarize.' };
    }

    coverageStart = messages[0].timestamp;
    coverageEnd = messages[messages.length - 1].timestamp;

    // Group messages into bounded batches (~24,000 chars per batch) to keep within context limits
    const batches = [];
    let curBatch = [];
    let curBatchChars = 0;
    const MAX_BATCH_CHARS = 24000;

    for (const m of messages) {
      const turnStr = `[Conv ID: ${m.conversation_id}] [Thread: "${m.conversation_title || 'Untitled'}"] [${m.timestamp}] ${m.role.toUpperCase()}: ${m.content.slice(0, 600)}\n`;
      if (curBatch.length > 0 && (curBatchChars + turnStr.length > MAX_BATCH_CHARS || curBatch.length >= 60)) {
        batches.push(curBatch);
        curBatch = [m];
        curBatchChars = turnStr.length;
      } else {
        curBatch.push(m);
        curBatchChars += turnStr.length;
      }
    }
    if (curBatch.length > 0) batches.push(curBatch);

    const allExtractedDigests = [];

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batchMsgs = batches[bIdx];
      const convTurns = batchMsgs.map(m =>
        `[Conv ID: ${m.conversation_id}] [Thread: "${m.conversation_title || 'Untitled'}"] [${m.timestamp}] ${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`
      ).join('\n');

      const prompt = `You are an AI knowledge archivist building an information retrieval search index over historical AI conversations.
Your objective is NOT to write vague prose for human reading. Your objective is to create information-dense, query-matchable search digests with exact technical keywords, architectural decisions, solved problems, and explicit provenance references.

INSTRUCTIONS:
1. Identify distinct topical and task clusters from the conversation turns.
2. For each cluster, produce a structured digest:
   - "title": Specific topic or task name (e.g. "SQLite FTS5 Hybrid Search Architecture & Electron Port Management").
   - "summary_text": High-entropy factual digest detailing problems diagnosed, decisions made, code architectures, configuration parameters, and answers given.
   - "entities": Array of exact keywords, technologies, filenames, protocols, libraries, acronyms, or concepts (e.g. ["SQLite", "FTS5", "better-sqlite3", "Vite", "RRF", "WAL"]).
   - "references": Array of source conversations referenced:
     [ { "id": "<Conv ID>", "title": "<Thread Title>", "type": "conversation" } ]

Respond ONLY with a valid JSON object matching this schema without markdown fences or commentary:
{
  "digests": [
    {
      "title": "Topic Name",
      "summary_text": "Detailed factual digest for search matching...",
      "entities": ["entity1", "entity2", "entity3"],
      "references": [
        { "id": "conversation-id-here", "title": "Thread Title", "type": "conversation" }
      ]
    }
  ]
}

CONVERSATION TURNS:
${convTurns}`;

      console.log(`[Summarizer:Conversations] Running AI digest batch ${bIdx + 1}/${batches.length} (provider=${provider}, model=${model})...`);
      let jsonResponse = '';
      const resText = await providerRouter.streamChat({
        provider,
        model,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You are an expert AI knowledge archivist. Output ONLY valid JSON matching the requested schema. No commentary, no fences.',
        apiKey: resolvedApiKey,
        jsonMode: true,
        onChunk: (chunk) => { jsonResponse += chunk; }
      });
      if (!jsonResponse.trim() && resText) {
        jsonResponse = resText;
      }

      try {
        const parsed = this.cleanAndParseJson(jsonResponse);
        const digestList = Array.isArray(parsed) ? parsed : (parsed.digests || []);
        allExtractedDigests.push(...digestList);
      } catch (err) {
        console.warn(`[Summarizer:Conversations] Batch ${bIdx + 1} parse failed:`, err.message);
      }
    }

    if (allExtractedDigests.length === 0) {
      return { success: true, corpus: 'ai_conversations', processedCount: messages.length, digestsCount: 0, message: 'AI returned 0 digests.' };
    }

    const now = new Date().toISOString();
    const createdDigests = [];

    db.transaction(() => {
      // Soft-delete historical digests in full mode ONLY if new digests were generated
      if (mode === 'full') {
        db.prepare(`UPDATE archive_digests SET is_deleted = 1 WHERE corpus_type = 'ai_conversations' AND is_deleted = 0`).run();
      }

      for (const d of allExtractedDigests) {
        const digestId = uuidv4();
        const entities = this.sanitizeEntities(d.entities);
        const references = this.sanitizeReferences(d.references, 'ai_conversations');

        db.prepare(`
          INSERT INTO archive_digests (
            id, corpus_type, title, summary_text, entities_json, references_json, 
            coverage_start, coverage_end, created_at, updated_at
          ) VALUES (?, 'ai_conversations', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          digestId,
          d.title || 'AI Conversation Digest',
          d.summary_text || '',
          JSON.stringify(entities),
          JSON.stringify(references),
          coverageStart,
          coverageEnd,
          now,
          now
        );

        createdDigests.push({
          id: digestId,
          title: d.title || 'AI Conversation Digest',
          summary_text: d.summary_text || '',
          entities,
          references
        });
      }
    })();

    // Queue for vector embeddings and write disk markdown files
    for (const d of createdDigests) {
      const textToEmbed = `${d.title}\n\n${d.summary_text}\n\nKeywords: ${d.entities.join(', ')}`;
      embeddingService.queueDigest(d.id, textToEmbed);

      const safeName = d.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) + `_${d.id.slice(0, 6)}.md`;
      const refMd = d.references.map(r => `- [[Conversation: "${r.title || 'Untitled'}"]](id:${r.id})`).join('\n');
      const entMd = d.entities.map(e => `\`${e}\``).join(' ');

      const fileContent = `---
title: "${d.title.replace(/"/g, '\\"')}"
corpus: "ai_conversations"
updated: "${now}"
coverage_start: "${coverageStart}"
coverage_end: "${coverageEnd}"
entities: ${JSON.stringify(d.entities)}
---

# ${d.title}

${d.summary_text}

### 🏷️ Indexed Entities
${entMd}

### 🔗 Provenance References
${refMd}
`;
      try {
        fs.writeFileSync(path.join(this.convSummariesDir, safeName), fileContent, 'utf8');
      } catch (e) {
        console.warn(`[Summarizer] Failed writing markdown file ${safeName}:`, e.message);
      }
    }

    return {
      success: true,
      corpus: 'ai_conversations',
      processedCount: messages.length,
      digestsCount: createdDigests.length,
      coverageStart,
      coverageEnd
    };
  }

  // --------------------------------------------------------------------------
  // Pipeline B: Obsidian Vault Notes Digest (Search-First Indexing)
  // --------------------------------------------------------------------------
  async summarizeObsidianVault({ mode = 'incremental', overrideProvider, overrideModel, apiKey }) {
    const { provider, model, resolvedApiKey } = this.resolveProviderAndModel(overrideProvider, overrideModel, apiKey);

    let notes = [];
    if (mode === 'incremental') {
      const latestObsidianDigest = db.prepare(`
        SELECT MAX(updated_at) as last_updated
        FROM archive_digests
        WHERE corpus_type = 'obsidian_notes' AND is_deleted = 0
      `).get();
      const lastUpdated = latestObsidianDigest?.last_updated || '1970-01-01T00:00:00';

      notes = db.prepare(`
        SELECT id, file_name, rel_path, title, content, updated_at
        FROM obsidian_notes
        WHERE updated_at > ?
        ORDER BY updated_at DESC
        LIMIT 100
      `).all(lastUpdated);

      // Do not duplicate old notes if none have changed
      if (notes.length === 0) {
        return { success: true, corpus: 'obsidian_notes', processedCount: 0, digestsCount: 0, message: 'No new or modified Obsidian notes to summarize.' };
      }
    } else {
      notes = db.prepare(`
        SELECT id, file_name, rel_path, title, content, created_at, updated_at
        FROM obsidian_notes
        ORDER BY created_at DESC
        LIMIT 250
      `).all();
    }

    if (notes.length === 0) {
      return { success: true, corpus: 'obsidian_notes', processedCount: 0, digestsCount: 0, message: 'No Obsidian notes found to summarize.' };
    }

    // Group notes into bounded batches (~24,000 chars per batch)
    const batches = [];
    let curBatch = [];
    let curBatchChars = 0;
    const MAX_BATCH_CHARS = 24000;

    for (const n of notes) {
      const noteStr = `[Note ID: ${n.id}] [Path: ${n.rel_path}] [Title: "${n.title}"] [Date: ${n.created_at || n.updated_at}]:\n${(n.content || '').slice(0, 750)}\n---\n`;
      if (curBatch.length > 0 && (curBatchChars + noteStr.length > MAX_BATCH_CHARS || curBatch.length >= 40)) {
        batches.push(curBatch);
        curBatch = [n];
        curBatchChars = noteStr.length;
      } else {
        curBatch.push(n);
        curBatchChars += noteStr.length;
      }
    }
    if (curBatch.length > 0) batches.push(curBatch);

    const allExtractedDigests = [];

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batchNotes = batches[bIdx];
      const notesSnippet = batchNotes.map(n =>
        `[Note ID: ${n.id}] [Path: ${n.rel_path}] [Title: "${n.title}"]:\n${(n.content || '').slice(0, 750)}`
      ).join('\n---\n');

      const prompt = `You are an AI knowledge archivist building an information retrieval search index over the user's Obsidian Vault personal notes.
Your objective is to extract cohesive knowledge cluster digests that act as an index for search retrieval.

INSTRUCTIONS:
1. Group related notes into meaningful topical and domain digests (e.g. project planning, research notes, technical architecture, personal logs).
2. For each digest:
   - "title": Descriptive thematic title (e.g. "Personal Health & Nutrition Protocols" or "Project Alpha Milestones & Design Docs").
   - "summary_text": Information-dense summary of core facts, decisions, status updates, outlines, and key data points found across the notes.
   - "entities": Array of exact keywords, project names, people, tools, locations, and concepts.
   - "references": Array of source notes referenced:
     [ { "id": "<Note ID>", "title": "<Title>", "rel_path": "<Path>", "type": "obsidian_note" } ]

Respond ONLY with a valid JSON object matching this schema without markdown fences or commentary:
{
  "digests": [
    {
      "title": "Topic Name",
      "summary_text": "Detailed factual digest for search matching...",
      "entities": ["entity1", "entity2", "entity3"],
      "references": [
        { "id": "note-id-here", "title": "Note Title", "rel_path": "path/to/note.md", "type": "obsidian_note" }
      ]
    }
  ]
}

OBSIDIAN NOTES:
${notesSnippet}`;

      console.log(`[Summarizer:Obsidian] Running AI digest batch ${bIdx + 1}/${batches.length} (provider=${provider}, model=${model})...`);
      let jsonResponse = '';
      const resText = await providerRouter.streamChat({
        provider,
        model,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You are an expert AI knowledge archivist. Output ONLY valid JSON matching the requested schema. No commentary, no fences.',
        apiKey: resolvedApiKey,
        jsonMode: true,
        onChunk: (chunk) => { jsonResponse += chunk; }
      });
      if (!jsonResponse.trim() && resText) {
        jsonResponse = resText;
      }

      try {
        const parsed = this.cleanAndParseJson(jsonResponse);
        const digestList = Array.isArray(parsed) ? parsed : (parsed.digests || []);
        allExtractedDigests.push(...digestList);
      } catch (err) {
        console.warn(`[Summarizer:Obsidian] Batch ${bIdx + 1} parse failed:`, err.message);
      }
    }

    if (allExtractedDigests.length === 0) {
      return { success: true, corpus: 'obsidian_notes', processedCount: notes.length, digestsCount: 0, message: 'AI returned 0 digests.' };
    }

    const now = new Date().toISOString();
    const createdDigests = [];

    db.transaction(() => {
      // Soft-delete historical digests in full mode ONLY if new digests were generated
      if (mode === 'full') {
        db.prepare(`UPDATE archive_digests SET is_deleted = 1 WHERE corpus_type = 'obsidian_notes' AND is_deleted = 0`).run();
      }

      for (const d of allExtractedDigests) {
        const digestId = uuidv4();
        const entities = this.sanitizeEntities(d.entities);
        const references = this.sanitizeReferences(d.references, 'obsidian_notes');

        db.prepare(`
          INSERT INTO archive_digests (
            id, corpus_type, title, summary_text, entities_json, references_json, 
            coverage_start, coverage_end, created_at, updated_at
          ) VALUES (?, 'obsidian_notes', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          digestId,
          d.title || 'Obsidian Vault Digest',
          d.summary_text || '',
          JSON.stringify(entities),
          JSON.stringify(references),
          null,
          null,
          now,
          now
        );

        createdDigests.push({
          id: digestId,
          title: d.title || 'Obsidian Vault Digest',
          summary_text: d.summary_text || '',
          entities,
          references
        });
      }
    })();

    // Queue for vector embeddings and write disk markdown files
    for (const d of createdDigests) {
      const textToEmbed = `${d.title}\n\n${d.summary_text}\n\nKeywords: ${d.entities.join(', ')}`;
      embeddingService.queueDigest(d.id, textToEmbed);

      const safeName = d.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) + `_${d.id.slice(0, 6)}.md`;
      const refMd = d.references.map(r => `- [[Obsidian Note: "${r.title || r.rel_path}"]](path:${r.rel_path || r.id})`).join('\n');
      const entMd = d.entities.map(e => `\`${e}\``).join(' ');

      const fileContent = `---
title: "${d.title.replace(/"/g, '\\"')}"
corpus: "obsidian_notes"
updated: "${now}"
entities: ${JSON.stringify(d.entities)}
---

# ${d.title}

${d.summary_text}

### 🏷️ Indexed Entities
${entMd}

### 🔗 Provenance References
${refMd}
`;
      try {
        fs.writeFileSync(path.join(this.obsidianSummariesDir, safeName), fileContent, 'utf8');
      } catch (e) {
        console.warn(`[Summarizer] Failed writing markdown file ${safeName}:`, e.message);
      }
    }

    return {
      success: true,
      corpus: 'obsidian_notes',
      processedCount: notes.length,
      digestsCount: createdDigests.length
    };
  }

  // --------------------------------------------------------------------------
  // Unified Orchestration Method
  // --------------------------------------------------------------------------
  async runSummarization({ corpus = 'all', mode = 'incremental', overrideProvider, overrideModel, apiKey }) {
    const results = {};

    if (corpus === 'all' || corpus === 'ai_conversations') {
      results.ai_conversations = await this.summarizeConversations({
        mode,
        overrideProvider,
        overrideModel,
        apiKey
      });
    }

    if (corpus === 'all' || corpus === 'obsidian_notes') {
      results.obsidian_notes = await this.summarizeObsidianVault({
        mode,
        overrideProvider,
        overrideModel,
        apiKey
      });
    }

    return {
      success: true,
      corpus,
      results
    };
  }
}

module.exports = new SummarizerService();
