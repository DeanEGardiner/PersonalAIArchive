const { db } = require('./db');
const config = require('./config');

class EmbeddingService {
  constructor() {
    this.isProcessing = false;
    this.queue = [];
    this.pollInterval = null;
    this.lastProviderStatus = null;
  }

  getEmbeddingConfig() {
    const enabled = config.getSetting('embedding_enabled', 'true') === 'true';
    const provider = config.getSetting('embedding_provider', 'lmstudio');
    const model = config.getSetting('embedding_model', 'text-embedding-nomic-embed-text-v1.5');
    return { enabled, provider, model };
  }

  float32ToBuffer(float32Array) {
    const arr = float32Array instanceof Float32Array ? float32Array : new Float32Array(float32Array);
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  }

  bufferToFloat32(buffer) {
    if (!buffer) return null;
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }

  cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i];
      const b = vecB[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async getVector(text, customConfig = null) {
    const { enabled, provider, model } = customConfig || this.getEmbeddingConfig();
    if (!enabled || !text || !text.trim()) return null;

    const cleanInput = text.slice(0, 4000).trim();

    try {
      if (provider === 'lmstudio') {
        const baseUrl = config.getLMStudioUrl();
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: cleanInput }),
          signal: AbortSignal.timeout(3500)
        });
        if (!res.ok) return null;
        const data = await res.json();
        const rawVec = data.data?.[0]?.embedding;
        return rawVec ? new Float32Array(rawVec) : null;
      } else if (provider === 'ollama') {
        const baseUrl = config.getOllamaUrl();
        // Try OpenAI compatible /v1/embeddings first, fallback to /api/embeddings
        try {
          const res = await fetch(`${baseUrl}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: cleanInput }),
            signal: AbortSignal.timeout(3500)
          });
          if (res.ok) {
            const data = await res.json();
            const rawVec = data.data?.[0]?.embedding;
            if (rawVec) return new Float32Array(rawVec);
          }
        } catch (_) {}

        const fallbackRes = await fetch(`${baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: cleanInput }),
          signal: AbortSignal.timeout(3500)
        });
        if (!fallbackRes.ok) return null;
        const fallbackData = await fallbackRes.json();
        const rawVec = fallbackData.embedding;
        return rawVec ? new Float32Array(rawVec) : null;
      }
    } catch (_) {
      // Local provider unavailable or timed out; silent fallback
      return null;
    }

    return null;
  }

  // Queue a message for asynchronous background embedding
  queueMessage(messageId, content) {
    if (!messageId || !content) return;
    this.queue.push({ type: 'message', id: messageId, text: content });
    this.triggerProcessing();
  }

  // Queue a summary for background embedding
  queueSummary(summaryId, summaryText) {
    if (!summaryId || !summaryText) return;
    this.queue.push({ type: 'summary', id: summaryId, text: summaryText });
    this.triggerProcessing();
  }

  // Queue an archive digest for background embedding
  queueDigest(digestId, digestText) {
    if (!digestId || !digestText) return;
    this.queue.push({ type: 'digest', id: digestId, text: digestText });
    this.triggerProcessing();
  }

  // Queue an Obsidian note for background embedding
  queueObsidianNote(noteId, noteText) {
    if (!noteId || !noteText) return;
    this.queue.push({ type: 'obsidian_note', id: noteId, text: noteText });
    this.triggerProcessing();
  }

  // Queue an atomic note chunk for background embedding
  queueChunk(chunkId, chunkText) {
    if (!chunkId || !chunkText) return;
    this.queue.push({ type: 'chunk', id: chunkId, text: chunkText });
    this.triggerProcessing();
  }

  triggerProcessing() {
    if (this.isProcessing) return;
    setImmediate(() => this.processQueue());
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const { enabled, model } = this.getEmbeddingConfig();
      if (!enabled) {
        this.isProcessing = false;
        return;
      }

      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item || !item.text) continue;

        try {
          const vec = await this.getVector(item.text);
          if (vec) {
            const buffer = this.float32ToBuffer(vec);
            if (item.type === 'message') {
              db.prepare(`
                INSERT INTO message_embeddings (message_id, embedding, model)
                VALUES (?, ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model
              `).run(item.id, buffer, model);
            } else if (item.type === 'summary') {
              db.prepare(`
                INSERT INTO summary_embeddings (summary_id, embedding, model)
                VALUES (?, ?, ?)
                ON CONFLICT(summary_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model
              `).run(item.id, buffer, model);
            } else if (item.type === 'digest') {
              db.prepare(`
                INSERT INTO digest_embeddings (digest_id, embedding, model)
                VALUES (?, ?, ?)
                ON CONFLICT(digest_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model
              `).run(item.id, buffer, model);
            } else if (item.type === 'obsidian_note') {
              db.prepare(`
                INSERT INTO obsidian_note_embeddings (note_id, embedding, model)
                VALUES (?, ?, ?)
                ON CONFLICT(note_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model
              `).run(item.id, buffer, model);
            } else if (item.type === 'chunk') {
              db.prepare(`
                INSERT INTO obsidian_chunk_embeddings (chunk_id, embedding, model)
                VALUES (?, ?, ?)
                ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model
              `).run(item.id, buffer, model);
            }
          }
        } catch (err) {
          console.warn(`[Embedding Queue Warning]: Failed to embed ${item.type} ${item.id}:`, err.message);
        }

        // Slight throttle between background requests to avoid GPU contention
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  // Backfill un-embedded messages, digests, obsidian notes, and chunks in background
  async backfillBatch(batchSize = 50) {
    const { enabled } = this.getEmbeddingConfig();
    if (!enabled) return { queued: 0 };

    const unEmbeddedMessages = db.prepare(`
      SELECT m.id, m.content
      FROM messages m
      LEFT JOIN message_embeddings me ON m.id = me.message_id
      WHERE m.is_deleted = 0 AND me.message_id IS NULL AND length(trim(m.content)) > 0
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(batchSize);

    for (const msg of unEmbeddedMessages) {
      this.queueMessage(msg.id, msg.content);
    }

    const unEmbeddedDigests = db.prepare(`
      SELECT d.id, d.title, d.summary_text, d.entities_json
      FROM archive_digests d
      LEFT JOIN digest_embeddings de ON d.id = de.digest_id
      WHERE d.is_deleted = 0 AND de.digest_id IS NULL AND length(trim(d.summary_text)) > 0
      LIMIT 20
    `).all();

    for (const dig of unEmbeddedDigests) {
      const text = `${dig.title}\n\n${dig.summary_text}\n\n${dig.entities_json || ''}`.slice(0, 4000);
      this.queueDigest(dig.id, text);
    }

    const unEmbeddedChunks = db.prepare(`
      SELECT c.id, c.heading, c.content, n.title
      FROM obsidian_chunks c
      JOIN obsidian_notes n ON c.note_id = n.id
      LEFT JOIN obsidian_chunk_embeddings ce ON c.id = ce.chunk_id
      WHERE ce.chunk_id IS NULL AND length(trim(c.content)) > 0
      LIMIT ?
    `).all(batchSize);

    for (const ch of unEmbeddedChunks) {
      const textToEmbed = `${ch.title} ${ch.heading ? `(${ch.heading})` : ''}\n\n${ch.content}`.slice(0, 3500);
      this.queueChunk(ch.id, textToEmbed);
    }

    const unEmbeddedNotes = db.prepare(`
      SELECT n.id, n.title, n.content
      FROM obsidian_notes n
      LEFT JOIN obsidian_note_embeddings ne ON n.id = ne.note_id
      WHERE ne.note_id IS NULL AND length(trim(n.content)) > 0
      LIMIT ?
    `).all(batchSize);

    for (const note of unEmbeddedNotes) {
      const textToEmbed = `${note.title}\n\n${note.content}`.slice(0, 4000);
      this.queueObsidianNote(note.id, textToEmbed);
    }

    return { 
      queued: unEmbeddedMessages.length + unEmbeddedDigests.length + unEmbeddedChunks.length + unEmbeddedNotes.length 
    };
  }

  getStatus() {
    const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages WHERE is_deleted = 0').get()?.count || 0;
    const embeddedMessages = db.prepare('SELECT COUNT(*) as count FROM message_embeddings').get()?.count || 0;
    const totalDigests = db.prepare('SELECT COUNT(*) as count FROM archive_digests WHERE is_deleted = 0').get()?.count || 0;
    const embeddedDigests = db.prepare('SELECT COUNT(*) as count FROM digest_embeddings').get()?.count || 0;
    const totalObsidianNotes = db.prepare('SELECT COUNT(*) as count FROM obsidian_notes').get()?.count || 0;
    const embeddedObsidianNotes = db.prepare('SELECT COUNT(*) as count FROM obsidian_note_embeddings').get()?.count || 0;
    const totalChunks = db.prepare('SELECT COUNT(*) as count FROM obsidian_chunks').get()?.count || 0;
    const embeddedChunks = db.prepare('SELECT COUNT(*) as count FROM obsidian_chunk_embeddings').get()?.count || 0;
    const totalEntities = db.prepare('SELECT COUNT(*) as count FROM archive_entities').get()?.count || 0;
    const conf = this.getEmbeddingConfig();

    return {
      config: conf,
      totalMessages,
      embeddedMessages,
      totalDigests,
      embeddedDigests,
      totalObsidianNotes,
      embeddedObsidianNotes,
      totalChunks,
      embeddedChunks,
      totalEntities,
      queueLength: this.queue.length,
      isProcessing: this.isProcessing
    };
  }
}

module.exports = new EmbeddingService();
