require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { ZipArchive } = require('archiver');
const multer = require('multer');

const { db, SUMMARIES_DIR, MEDIA_DIR } = require('./db');
const config = require('./config');
const providerRouter = require('./providers');
const summarizer = require('./summarizer');
const obsidianSync = require('./obsidianSync');

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '127.0.0.1';

// Restrict CORS to local web clients
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3002',
  'http://127.0.0.1:3002'
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: Personal AI Archive only allows local requests'));
    }
  }
}));

app.use(express.json());

// Serve summaries and media directories for direct file viewing
app.use('/summaries-files', express.static(SUMMARIES_DIR));
app.use('/media', express.static(MEDIA_DIR));

// Configure Multer for image uploads with MIME filter
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `img-${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are permitted'));
    }
  }
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const fileUrl = `/media/${req.file.filename}`;
  res.json({
    file_name: req.file.originalname,
    file_path: fileUrl,
    mime_type: req.file.mimetype,
    file_size: req.file.size
  });
});

// -------------------------------------------------------------
// Provider Health Endpoint
// -------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const health = await providerRouter.checkHealth();
    res.json(health);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Settings Endpoints (with secret masking)
// -------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json(config.getPublicSettings());
});

app.post('/api/settings', (req, res) => {
  const updates = req.body || {};
  db.transaction(() => {
    for (const [k, v] of Object.entries(updates)) {
      if (typeof v !== 'string') continue;
      const cleanVal = v.trim();
      // Skip masked placeholders (e.g. ••••abcd) so existing secret keys are not clobbered
      if (cleanVal.startsWith('••••') || cleanVal === '••••') {
        continue;
      }
      config.setSetting(k, cleanVal);
    }
  })();
  res.json({ success: true, settings: config.getPublicSettings() });
});

// -------------------------------------------------------------
// Conversations & Messages Endpoints
// -------------------------------------------------------------
app.get('/api/conversations', (req, res) => {
  const conversations = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_deleted = 0) as message_count,
      (SELECT content FROM messages WHERE conversation_id = c.id AND is_deleted = 0 ORDER BY timestamp DESC LIMIT 1) as last_message
    FROM conversations c
    WHERE c.is_deleted = 0
    ORDER BY c.updated_at DESC
  `).all();
  res.json(conversations);
});

app.post('/api/conversations', (req, res) => {
  const { title, provider, model } = req.body || {};
  const id = uuidv4();
  const now = new Date().toISOString();
  const targetProvider = provider || config.DEFAULT_PROVIDER;
  const targetModel = config.resolveModel(targetProvider, model);

  db.prepare(`
    INSERT INTO conversations (id, title, default_provider, default_model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title || 'New Conversation', targetProvider, targetModel, now, now);

  res.json({ id, title: title || 'New Conversation', default_provider: targetProvider, default_model: targetModel });
});

app.delete('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  db.prepare('UPDATE conversations SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
  db.prepare('UPDATE messages SET is_deleted = 1, updated_at = ? WHERE conversation_id = ?').run(now, id);
  res.json({ success: true });
});

app.get('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_deleted = 0').get(id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const messages = db.prepare(`
    SELECT * FROM messages 
    WHERE conversation_id = ? AND is_deleted = 0
    ORDER BY timestamp ASC
  `).all(id);

  // Batch query attachments (fixes N+1)
  if (messages.length > 0) {
    const msgIds = messages.map(m => m.id);
    const placeholders = msgIds.map(() => '?').join(',');
    const allAtts = db.prepare(`SELECT * FROM attachments WHERE message_id IN (${placeholders}) AND is_deleted = 0`).all(...msgIds);
    const attMap = {};
    for (const a of allAtts) {
      if (!attMap[a.message_id]) attMap[a.message_id] = [];
      attMap[a.message_id].push(a);
    }
    for (const m of messages) {
      m.attachments = attMap[m.id] || [];
    }
  }

  res.json({ ...conv, messages });
});

// -------------------------------------------------------------
// Unified Post & Stream Endpoint (Merging Strategy)
// Supports:
// - Standard JSON response
// - Server-Sent Events (SSE) streaming when stream=true or Accept: text/event-stream
// - Modes: 'standard' | 'ai_analysis' (with multi-turn context) | 'google_search'
// -------------------------------------------------------------
app.post(['/api/conversations/:id/posts', '/api/posts'], async (req, res) => {
  let { id: convId } = req.params;
  const { 
    conversationId,
    content, 
    mode = 'standard', // 'standard' | 'ai_analysis' | 'google_search'
    attachment,
    provider,
    model,
    stream: wantStreamBody
  } = req.body || {};

  const isStreamRequest = req.query.stream === 'true' || 
                          wantStreamBody === true || 
                          (req.headers.accept && req.headers.accept.includes('text/event-stream'));

  if (convId === 'new' || !convId) {
    convId = conversationId || null;
  }

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Post content cannot be empty.' });
  }

  const cleanContent = content.trim();
  const now = new Date().toISOString();
  let conversation = null;

  if (convId) {
    conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_deleted = 0').get(convId);
  }

  const targetProvider = provider || conversation?.default_provider || config.DEFAULT_PROVIDER;
  const targetModel = config.resolveModel(targetProvider, model || conversation?.default_model);

  if (!conversation) {
    convId = uuidv4();
    const cleanTitle = cleanContent.slice(0, 40) + (cleanContent.length > 40 ? '...' : '');
    db.prepare(`
      INSERT INTO conversations (id, title, default_provider, default_model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(convId, cleanTitle, targetProvider, targetModel, now, now);
    conversation = { id: convId, title: cleanTitle };
  } else if (!conversation.title || conversation.title === 'New Conversation' || conversation.title === 'Untitled Conversation') {
    const cleanTitle = cleanContent.slice(0, 40) + (cleanContent.length > 40 ? '...' : '');
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(cleanTitle, now, convId);
    conversation.title = cleanTitle;
  } else {
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
  }

  // 1. Create User Message (FTS is updated automatically via trigger!)
  const userMsgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
    VALUES (?, ?, 'user', 'user', ?, 'completed', ?, ?, ?, ?)
  `).run(userMsgId, convId, cleanContent, targetProvider, targetModel, now, now);

  // Attach media if provided
  let userAttachment = null;
  if (attachment && attachment.file_path) {
    const attId = uuidv4();
    db.prepare(`
      INSERT INTO attachments (id, message_id, file_name, file_path, mime_type, file_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(attId, userMsgId, attachment.file_name || 'image.jpg', attachment.file_path, attachment.mime_type || 'image/jpeg', attachment.file_size || 0, now, now);
    userAttachment = {
      id: attId,
      message_id: userMsgId,
      file_name: attachment.file_name,
      file_path: attachment.file_path,
      mime_type: attachment.mime_type
    };
  }

  const userMessage = {
    id: userMsgId,
    conversation_id: convId,
    role: 'user',
    post_type: 'user',
    content: cleanContent,
    status: 'completed',
    provider: targetProvider,
    model: targetModel,
    timestamp: now,
    attachments: userAttachment ? [userAttachment] : []
  };

  // Option 1: "standard" -> Return user message immediately
  if (mode === 'standard') {
    if (isStreamRequest) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ type: 'init', conversationId: convId, conversationTitle: conversation.title, userMessage })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', conversationId: convId, userMessage, aiResponse: null })}\n\n`);
      return res.end();
    }

    return res.json({
      conversationId: convId,
      conversationTitle: conversation.title,
      userMessage,
      aiResponse: null
    });
  }

  // -------------------------------------------------------------
  // Gather Context for AI Analysis or Google Search
  // -------------------------------------------------------------
  const postImages = [];
  if (attachment && attachment.file_path) {
    postImages.push(attachment);
  }

  // Multi-turn conversation history for context continuity (with timestamps)
  const conversationHistory = db.prepare(`
    SELECT role, content, timestamp FROM messages
    WHERE conversation_id = ? AND id != ? AND is_deleted = 0
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(convId, userMsgId, config.HISTORY_TURNS).reverse();

  let archiveContext = '';
  if (mode === 'ai_analysis') {
    const stopWords = new Set([
      'can', 'you', 'scan', 'the', 'local', 'archive', 'and', 'tell', 'me', 'if', 
      'there', 'is', 'are', 'was', 'were', 'record', 'records', 'of', 'when', 'what', 
      'where', 'how', 'who', 'why', 'which', 'located', 'in', 'at', 'on', 'to', 'for', 
      'about', 'with', 'from', 'a', 'an', 'please', 'check', 'find', 'search', 'query', 
      'show', 'give', 'any', 'information', 'details', 'do', 'does', 'did', 'have', 'has'
    ]);
    const words = cleanContent.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

    let searchHits = [];
    try {
      if (words.length > 0) {
        // Query external-content FTS5 (joined on rowid)
        const andFts = words.map(w => `${w}*`).join(' AND ');
        searchHits = db.prepare(`
          SELECT m.content, m.role, m.timestamp, c.title as conversation_title
          FROM messages_fts fts
          JOIN messages m ON fts.rowid = m.rowid
          JOIN conversations c ON m.conversation_id = c.id
          WHERE messages_fts MATCH ? AND m.id != ? AND m.is_deleted = 0
          ORDER BY m.timestamp DESC
          LIMIT 5
        `).all(andFts, userMsgId);

        if (searchHits.length === 0 && words.length > 1) {
          const orFts = words.map(w => `${w}*`).join(' OR ');
          searchHits = db.prepare(`
            SELECT m.content, m.role, m.timestamp, c.title as conversation_title
            FROM messages_fts fts
            JOIN messages m ON fts.rowid = m.rowid
            JOIN conversations c ON m.conversation_id = c.id
            WHERE messages_fts MATCH ? AND m.id != ? AND m.is_deleted = 0
            ORDER BY m.timestamp DESC
            LIMIT 5
          `).all(orFts, userMsgId);
        }
      }
    } catch (ftsErr) {
      console.warn('[FTS Archive Search Warning]:', ftsErr.message);
    }

    const summaries = db.prepare(`
      SELECT s.summary_text, c.name as category_name
      FROM archive_summaries s
      LEFT JOIN categories c ON s.category_id = c.id
      WHERE s.is_deleted = 0
      ORDER BY s.updated_at DESC
      LIMIT 3
    `).all();

    let contextParts = [];
    if (searchHits.length > 0) {
      contextParts.push(`### Relevant Past Archive Conversations:\n` + searchHits.map(h => {
        const snippet = h.content.length > 1000 ? h.content.slice(0, 1000) + '... [truncated]' : h.content;
        const ts = h.timestamp ? ` [${h.timestamp}]` : '';
        return `[Conversation: "${h.conversation_title}"] (${h.role})${ts}: ${snippet}`;
      }).join('\n\n'));
    }

    let obsidianHits = [];
    try {
      if (words.length > 0) {
        obsidianHits = obsidianSync.searchNotes(words.join(' '), 3);
      }
    } catch (_) {}

    if (obsidianHits.length > 0) {
      contextParts.push(`### Relevant Obsidian Vault Notes:\n` + obsidianHits.map(n => {
        const fullNote = obsidianSync.getNoteById(n.id);
        const rawContent = fullNote?.content || n.preview || '';
        const snippet = rawContent.length > 1000 ? rawContent.slice(0, 1000) + '... [truncated]' : rawContent;
        const noteTime = n.updated_at || (n.mtime_ms ? new Date(n.mtime_ms).toISOString() : '');
        return `[Obsidian Note: "${n.title}"] (${n.rel_path})${noteTime ? ` [Updated: ${noteTime}]` : ''}:\n${snippet}`;
      }).join('\n\n'));
    }

    if (summaries.length > 0) {
      contextParts.push(`### Archive Summaries:\n` + summaries.map(s => {
        const sSnippet = s.summary_text.length > 600 ? s.summary_text.slice(0, 600) + '... [truncated]' : s.summary_text;
        return `[${s.category_name || 'Global Digest'}]: ${sSnippet}`;
      }).join('\n\n'));
    }
    archiveContext = contextParts.join('\n\n');
  }

  // -------------------------------------------------------------
  // Execution: Streaming (SSE) or Non-Streaming JSON
  // -------------------------------------------------------------
  const abortController = new AbortController();

  if (isStreamRequest) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`data: ${JSON.stringify({ type: 'init', conversationId: convId, conversationTitle: conversation.title, userMessage })}\n\n`);

    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    let fullText = '';
    const onChunk = (chunk) => {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
    };

    try {
      let finalResult;
      if (mode === 'ai_analysis') {
        finalResult = await providerRouter.analyzeArchiveKnowledge({
          userPost: cleanContent,
          conversationTitle: conversation.title,
          archiveContext,
          conversationHistory,
          images: postImages,
          model: targetModel,
          provider: targetProvider,
          abortSignal: abortController.signal,
          postTimestamp: now,
          onChunk
        });
      } else if (mode === 'google_search') {
        finalResult = await providerRouter.googleSearchAI({
          query: cleanContent,
          images: postImages,
          model: targetModel,
          abortSignal: abortController.signal,
          onChunk
        });
      }

      const aiText = finalResult.summary || finalResult.text || fullText;
      const actualProvider = finalResult.provider || targetProvider;
      const actualModel = finalResult.model || targetModel;

      const aiMsgId = uuidv4();
      const aiTime = new Date().toISOString();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
        VALUES (?, ?, 'assistant', ?, ?, 'completed', ?, ?, ?, ?)
      `).run(aiMsgId, convId, mode, aiText, actualProvider, actualModel, aiTime, aiTime);

      const aiResponse = {
        id: aiMsgId,
        conversation_id: convId,
        role: 'assistant',
        post_type: mode,
        content: aiText,
        status: 'completed',
        provider: actualProvider,
        model: actualModel,
        timestamp: aiTime,
        attachments: []
      };

      res.write(`data: ${JSON.stringify({ type: 'done', conversationId: convId, userMessage, aiResponse, status: 'completed' })}\n\n`);
      return res.end();
    } catch (err) {
      const isInterrupted = abortController.signal.aborted;
      const status = isInterrupted ? 'interrupted' : 'error';
      const errorText = isInterrupted 
        ? fullText || '(Generation interrupted)' 
        : `⚠️ Error generating ${mode === 'google_search' ? 'Google Cloud Search' : 'Archive Analysis'}: ${err.message}`;

      const errId = uuidv4();
      const errTime = new Date().toISOString();
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)
      `).run(errId, convId, mode, errorText, status, targetProvider, targetModel, errTime, errTime);

      const aiResponse = {
        id: errId,
        conversation_id: convId,
        role: 'assistant',
        post_type: mode,
        content: errorText,
        status,
        provider: targetProvider,
        model: targetModel,
        timestamp: errTime,
        attachments: []
      };

      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', conversationId: convId, userMessage, aiResponse, status })}\n\n`);
      return res.end();
    }
  }

  // Non-streaming fallback
  try {
    let finalResult;
    if (mode === 'ai_analysis') {
      finalResult = await providerRouter.analyzeArchiveKnowledge({
        userPost: cleanContent,
        conversationTitle: conversation.title,
        archiveContext,
        conversationHistory,
        images: postImages,
        model: targetModel,
        provider: targetProvider,
        postTimestamp: now
      });
    } else if (mode === 'google_search') {
      finalResult = await providerRouter.googleSearchAI({
        query: cleanContent,
        images: postImages,
        model: targetModel
      });
    }

    const aiText = finalResult.summary || finalResult.text;
    const actualProvider = finalResult.provider || targetProvider;
    const actualModel = finalResult.model || targetModel;

    const aiMsgId = uuidv4();
    const aiTime = new Date().toISOString();
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
      VALUES (?, ?, 'assistant', ?, ?, 'completed', ?, ?, ?, ?)
    `).run(aiMsgId, convId, mode, aiText, actualProvider, actualModel, aiTime, aiTime);

    const aiResponse = {
      id: aiMsgId,
      conversation_id: convId,
      role: 'assistant',
      post_type: mode,
      content: aiText,
      status: 'completed',
      provider: actualProvider,
      model: actualModel,
      timestamp: aiTime,
      attachments: []
    };

    return res.json({
      conversationId: convId,
      conversationTitle: conversation.title,
      userMessage,
      aiResponse
    });
  } catch (err) {
    const errId = uuidv4();
    const errTime = new Date().toISOString();
    const errorText = `⚠️ Error generating ${mode === 'google_search' ? 'Google Cloud Search' : 'Archive Analysis'}: ${err.message}`;

    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
      VALUES (?, ?, 'assistant', ?, ?, 'error', ?, ?, ?, ?)
    `).run(errId, convId, mode, errorText, targetProvider, targetModel, errTime, errTime);

    return res.json({
      conversationId: convId,
      conversationTitle: conversation.title,
      userMessage,
      aiResponse: {
        id: errId,
        conversation_id: convId,
        role: 'assistant',
        post_type: mode,
        content: errorText,
        status: 'error',
        provider: targetProvider,
        model: targetModel,
        timestamp: errTime,
        attachments: []
      }
    });
  }
});

// Direct message creation into a conversation
app.post('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const { role = 'assistant', content, provider, model } = req.body || {};

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message content cannot be empty' });
  }

  const conv = db.prepare('SELECT id, default_provider, default_model FROM conversations WHERE id = ? AND is_deleted = 0').get(id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const msgId = uuidv4();
  const now = new Date().toISOString();
  const targetProvider = provider || conv.default_provider || config.DEFAULT_PROVIDER;
  const targetModel = config.resolveModel(targetProvider, model || conv.default_model);

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
  `).run(msgId, id, role, role === 'user' ? 'user' : 'standard', content.trim(), targetProvider, targetModel, now, now);

  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);

  res.json({
    id: msgId,
    conversation_id: id,
    role,
    content: content.trim(),
    status: 'completed',
    provider: targetProvider,
    model: targetModel,
    timestamp: now
  });
});

// -------------------------------------------------------------
// URL Summary Endpoint (AI Web Page Summary)
// -------------------------------------------------------------
app.post('/api/summarize-url', async (req, res) => {
  const { url, model } = req.body || {};
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const result = await providerRouter.summarizeURL({
      url: url.trim(),
      model
    });

    res.json({
      success: true,
      url: result.url,
      title: result.title,
      summary: result.summary,
      model: result.model
    });
  } catch (err) {
    console.error('[URL Summary Error]:', err);
    res.status(500).json({ error: err.message || 'Failed to summarize web page.' });
  }
});

// -------------------------------------------------------------
// Archive Explorer & Search Endpoints (FTS5 on rowid)
// -------------------------------------------------------------
app.get('/api/archive/search', (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.json([]);
  }

  const cleanQuery = q.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  try {
    const results = db.prepare(`
      SELECT m.*, c.title as conversation_title
      FROM messages_fts fts
      JOIN messages m ON fts.rowid = m.rowid
      JOIN conversations c ON m.conversation_id = c.id
      WHERE messages_fts MATCH ? AND m.is_deleted = 0
      ORDER BY m.timestamp DESC
      LIMIT 50
    `).all(cleanQuery + '*');
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: 'Search failed: ' + err.message });
  }
});

app.get('/api/archive/timeline', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const messages = db.prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, m.provider, m.model, c.title as conversation_title
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE m.is_deleted = 0
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(limit);
  res.json(messages);
});

// -------------------------------------------------------------
// Summarization & Category Endpoints
// -------------------------------------------------------------
app.get('/api/summaries/preview', (req, res) => {
  const { mode = 'incremental' } = req.query;
  const preview = summarizer.getPendingMessagesCount(mode);
  const summarizerConf = summarizer.getSummarizerConfig();
  res.json({ ...preview, config: summarizerConf });
});

app.get('/api/categories', (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, 
      (SELECT summary_text FROM archive_summaries WHERE category_id = c.id AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1) as latest_summary,
      (SELECT coverage_end FROM archive_summaries WHERE category_id = c.id AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1) as last_updated
    FROM categories c
    WHERE c.is_deleted = 0
    ORDER BY c.name ASC
  `).all();
  res.json(categories);
});

app.get('/api/summaries', (req, res) => {
  const summaries = db.prepare(`
    SELECT s.*, c.name as category_name
    FROM archive_summaries s
    LEFT JOIN categories c ON s.category_id = c.id
    WHERE s.is_deleted = 0
    ORDER BY s.created_at DESC
  `).all();
  res.json(summaries);
});

app.get('/api/summaries/global', (req, res) => {
  const global = db.prepare(`
    SELECT * FROM archive_summaries 
    WHERE summary_type = 'global' AND is_deleted = 0 
    ORDER BY created_at DESC LIMIT 1
  `).get();
  res.json(global || null);
});

app.post('/api/summaries/generate', async (req, res) => {
  const { mode = 'incremental', overrideProvider, overrideModel, apiKey } = req.body || {};
  try {
    const result = await summarizer.runSummarization({ mode, overrideProvider, overrideModel, apiKey });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Data Export (Obsidian Markdown Vault Zip & JSON)
// -------------------------------------------------------------
app.get('/api/export/markdown', (req, res) => {
  try {
    const archive = new ZipArchive({ zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('Archive generation error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to generate markdown zip: ' + err.message });
      }
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Personal_AI_Archive_Obsidian_Vault.zip"');

    archive.pipe(res);

    const addedSummaries = new Set();

    // 1. Summaries on disk
    if (fs.existsSync(SUMMARIES_DIR)) {
      const summaryFiles = fs.readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.md'));
      for (const file of summaryFiles) {
        const filePath = path.join(SUMMARIES_DIR, file);
        archive.file(filePath, { name: `Summaries/${file}` });
        addedSummaries.add(file.toLowerCase());
      }
    }

    // Include database summaries if not already added
    const dbSummaries = db.prepare(`
      SELECT s.*, c.name as category_name, c.description as category_desc 
      FROM archive_summaries s
      LEFT JOIN categories c ON s.category_id = c.id
      WHERE s.is_deleted = 0
    `).all();

    for (const s of dbSummaries) {
      if (s.summary_type === 'global' && !addedSummaries.has('global_archive_digest.md')) {
        const globalContent = `---
type: "global_digest"
updated: "${s.updated_at || s.created_at}"
source: "Personal AI Archive"
---

# Global Executive Archive Digest

${s.summary_text}
`;
        archive.append(globalContent, { name: 'Summaries/Global_Archive_Digest.md' });
        addedSummaries.add('global_archive_digest.md');
      } else if (s.category_name) {
        const safeName = s.category_name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
        if (!addedSummaries.has(safeName.toLowerCase())) {
          const catContent = `---
category: "${s.category_name}"
updated: "${s.updated_at || s.created_at}"
coverage_start: "${s.coverage_start || ''}"
coverage_end: "${s.coverage_end || ''}"
source: "Personal AI Archive"
---

# ${s.category_name}

${s.category_desc ? `*${s.category_desc}*\n\n` : ''}## Summary & Decisions
${s.summary_text}
`;
          archive.append(catContent, { name: `Summaries/${safeName}` });
          addedSummaries.add(safeName.toLowerCase());
        }
      }
    }

    // 2. Add Conversations as Obsidian notes
    const conversations = db.prepare('SELECT * FROM conversations WHERE is_deleted = 0 ORDER BY created_at DESC').all();
    const messageStmt = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY timestamp ASC');

    const usedFilenames = new Set();
    const convIndexList = [];

    for (const conv of conversations) {
      const msgs = messageStmt.all(conv.id);
      const createdDate = conv.created_at ? new Date(conv.created_at).toISOString().split('T')[0] : 'undated';
      const cleanTitle = (conv.title || 'Untitled Conversation')
        .replace(/[/\\\\?%*:|"<>]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);

      let filename = `${createdDate}_${cleanTitle || 'Conversation'}.md`;
      if (usedFilenames.has(filename.toLowerCase())) {
        filename = `${createdDate}_${cleanTitle || 'Conversation'}_${conv.id.slice(0, 6)}.md`;
      }
      usedFilenames.add(filename.toLowerCase());

      convIndexList.push({
        title: conv.title || 'Untitled Conversation',
        filename,
        date: createdDate,
        provider: conv.default_provider || 'AI',
        model: conv.default_model || '',
        messageCount: msgs.length
      });

      const yamlFrontmatter = [
        '---',
        `id: "${conv.id}"`,
        `title: "${(conv.title || '').replace(/"/g, '\\"')}"`,
        `created: "${conv.created_at}"`,
        `updated: "${conv.updated_at}"`,
        `provider: "${conv.default_provider || 'AI'}"`,
        `model: "${conv.default_model || 'default'}"`,
        'tags:',
        '  - "ai-archive"',
        '  - "conversation"',
        '---',
        '',
        ''
      ].join('\n');

      let body = `# ${conv.title || 'Untitled Conversation'}\n\n`;
      body += `- **Created:** ${conv.created_at || 'Unknown'}\n`;
      body += `- **Provider:** ${(conv.default_provider || 'AI').toUpperCase()} | **Model:** ${conv.default_model || 'default'}\n`;
      body += `\n---\n\n`;

      if (msgs.length === 0) {
        body += `*No messages in this conversation.*\n`;
      } else {
        for (const msg of msgs) {
          const roleLabel = msg.role === 'user' ? '👤 User' : `🤖 Assistant (${(msg.provider || conv.default_provider || 'AI').toUpperCase()} - ${msg.model || conv.default_model || 'model'})`;
          const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

          body += `### ${roleLabel}${timeStr ? ` · ${timeStr}` : ''}\n\n`;
          body += `${msg.content}\n\n`;
          body += `---\n\n`;
        }
      }

      archive.append(yamlFrontmatter + body, { name: `Conversations/${filename}` });
    }

    // 3. Vault Index / README
    let indexMd = `# Personal AI Archive — Obsidian Vault\n\n`;
    indexMd += `Exported from Personal AI Archive on ${new Date().toLocaleString()}.\n\n`;
    indexMd += `## 📚 Knowledge Summaries & Digests\n\n`;
    indexMd += `- [[Summaries/Global_Archive_Digest|🌐 Global Executive Archive Digest]]\n`;

    const catRows = db.prepare('SELECT name FROM categories WHERE is_deleted = 0 ORDER BY name ASC').all();
    if (catRows.length > 0) {
      for (const c of catRows) {
        const safeName = c.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        indexMd += `- [[Summaries/${safeName}|📁 ${c.name}]]\n`;
      }
    }

    indexMd += `\n## 💬 Conversations & Threads (${convIndexList.length})\n\n`;
    indexMd += `| Date | Conversation | Provider | Model | Messages |\n`;
    indexMd += `| :--- | :--- | :--- | :--- | :---: |\n`;
    for (const c of convIndexList) {
      indexMd += `| ${c.date} | [[Conversations/${c.filename.replace(/\.md$/, '')}|${c.title}]] | ${c.provider} | ${c.model} | ${c.messageCount} |\n`;
    }

    archive.append(indexMd, { name: 'Vault_Index.md' });
    archive.append(indexMd, { name: 'README.md' });

    archive.finalize();
  } catch (err) {
    console.error('Export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/export/json', (req, res) => {
  const conversations = db.prepare('SELECT * FROM conversations WHERE is_deleted = 0').all();
  const messages = db.prepare('SELECT * FROM messages WHERE is_deleted = 0').all();
  const categories = db.prepare('SELECT * FROM categories WHERE is_deleted = 0').all();
  const summaries = db.prepare('SELECT * FROM archive_summaries WHERE is_deleted = 0').all();

  res.setHeader('Content-Disposition', 'attachment; filename="personal_ai_archive_backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ conversations, messages, categories, summaries, exported_at: new Date().toISOString() }, null, 2));
});

// -------------------------------------------------------------
// Obsidian Vault Integration Endpoints
// -------------------------------------------------------------
app.get('/api/obsidian/status', (req, res) => {
  try {
    const status = obsidianSync.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obsidian/vault-path', (req, res) => {
  try {
    const { vaultPath } = req.body || {};
    obsidianSync.setVaultPath(vaultPath);
    const status = obsidianSync.getStatus();
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/obsidian/sync', async (req, res) => {
  try {
    const { vaultPath } = req.body || {};
    const result = await obsidianSync.sync(vaultPath);
    res.json(result);
  } catch (err) {
    console.error('[Obsidian Sync Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/obsidian/notes', (req, res) => {
  try {
    const { q = '', limit = 100 } = req.query;
    const notes = obsidianSync.searchNotes(q, parseInt(limit, 10) || 100);
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/obsidian/notes/:id', (req, res) => {
  try {
    const note = obsidianSync.getNoteById(req.params.id);
    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Serve Frontend (Vite build output)
// -------------------------------------------------------------
const CLIENT_DIST = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/summaries-files') && !req.path.startsWith('/media')) {
      return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    }
    next();
  });
}

// Start Express Server bound to HOST (localhost/127.0.0.1)
const server = app.listen(PORT, HOST, () => {
  console.log(`Personal AI Archive server running on http://${HOST}:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server Error] Port ${PORT} is already in use by another process.`);
  } else {
    console.error(`[Server Error]`, err);
  }
});
