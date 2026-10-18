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
const embeddingService = require('./embeddingService');
const hybridSearch = require('./hybridSearch');
const mindmapService = require('./mindmapService');

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '127.0.0.1';

// Restrict CORS to local web clients
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
]);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: Personal AI Archive only allows local requests'));
    }
  }
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

app.patch('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const { title, provider, model } = req.body || {};
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND is_deleted = 0').get(id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const existingMsgCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_deleted = 0').get(id)?.count || 0;

  // Once a conversation has messages, its model and provider are strictly locked to preserve thread integrity
  if (existingMsgCount > 0 && ((provider !== undefined && provider !== conv.default_provider) || (model !== undefined && model !== conv.default_model))) {
    return res.status(409).json({ error: 'Conversation model is locked once messages have been posted.' });
  }

  const now = new Date().toISOString();
  const newTitle = title !== undefined ? title : conv.title;
  const newProvider = provider !== undefined ? provider : conv.default_provider;
  const newModel = model !== undefined ? model : conv.default_model;

  db.prepare(`
    UPDATE conversations 
    SET title = ?, default_provider = ?, default_model = ?, updated_at = ?
    WHERE id = ?
  `).run(newTitle, newProvider, newModel, now, id);

  res.json({
    id,
    title: newTitle,
    default_provider: newProvider,
    default_model: newModel,
    updated_at: now
  });
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

  // Read-only model fallback attribution if default_provider is null in legacy rows
  if (!conv.default_provider && messages.length > 0) {
    const nonSystem = messages.filter(m => m.provider && m.provider !== 'system');
    const userMsgs = nonSystem.filter(m => m.role === 'user');
    const anchorMsg = userMsgs.length > 0 ? userMsgs[0] : nonSystem[0];
    if (anchorMsg) {
      conv.default_provider = anchorMsg.provider;
      conv.default_model = anchorMsg.model;
    }
  }

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

  const existingMsgCount = convId ? (db.prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ? AND is_deleted = 0').get(convId)?.count || 0) : 0;

  let targetProvider;
  let targetModel;

  if (!conversation || existingMsgCount === 0) {
    // New or unstarted conversation: accept requested provider/model or fall back
    targetProvider = provider || conversation?.default_provider || config.DEFAULT_PROVIDER;
    targetModel = config.resolveModel(targetProvider, model || conversation?.default_model);
  } else {
    // Conversation has already started: model & provider are strictly locked to anchor
    targetProvider = conversation.default_provider;
    targetModel = conversation.default_model;

    if (!targetProvider || !targetModel) {
      const anchor = db.prepare(`
        SELECT provider, model FROM messages 
        WHERE conversation_id = ? AND is_deleted = 0 AND provider IS NOT NULL AND provider != 'system'
        ORDER BY timestamp ASC LIMIT 1
      `).get(convId);
      targetProvider = anchor?.provider || config.DEFAULT_PROVIDER;
      targetModel = config.resolveModel(targetProvider, anchor?.model);
      db.prepare('UPDATE conversations SET default_provider = ?, default_model = ? WHERE id = ?').run(targetProvider, targetModel, convId);
    }
  }

  if (!conversation) {
    convId = uuidv4();
    const cleanTitle = cleanContent.slice(0, 40) + (cleanContent.length > 40 ? '...' : '');
    db.prepare(`
      INSERT INTO conversations (id, title, default_provider, default_model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(convId, cleanTitle, targetProvider, targetModel, now, now);
    conversation = { id: convId, title: cleanTitle, default_provider: targetProvider, default_model: targetModel };
  } else {
    const isDefaultTitle = !conversation.title || conversation.title === 'New Conversation' || conversation.title === 'Untitled Conversation';
    const cleanTitle = isDefaultTitle ? (cleanContent.slice(0, 40) + (cleanContent.length > 40 ? '...' : '')) : conversation.title;

    if (existingMsgCount === 0) {
      db.prepare('UPDATE conversations SET title = ?, default_provider = ?, default_model = ?, updated_at = ? WHERE id = ?').run(cleanTitle, targetProvider, targetModel, now, convId);
      conversation.default_provider = targetProvider;
      conversation.default_model = targetModel;
    } else if (isDefaultTitle) {
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(cleanTitle, now, convId);
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    }
    conversation.title = cleanTitle;
  }

  // 1. Create User Message (FTS is updated automatically via trigger!)
  const userMsgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, post_type, content, status, provider, model, timestamp, updated_at)
    VALUES (?, ?, 'user', 'user', ?, 'completed', ?, ?, ?, ?)
  `).run(userMsgId, convId, cleanContent, targetProvider, targetModel, now, now);

  // Queue user message for background embedding
  embeddingService.queueMessage(userMsgId, cleanContent);

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
    try {
      const searchRes = await hybridSearch.assembleContext(cleanContent, {
        excludeMessageId: userMsgId,
        excludeConversationId: convId,
        maxTotalChars: 7500
      });
      archiveContext = searchRes.contextText;
    } catch (err) {
      console.warn('[Hybrid Context Assembly Error]:', err.message);
    }
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

      embeddingService.queueMessage(aiMsgId, aiText);

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

    embeddingService.queueMessage(aiMsgId, aiText);

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
      provider: result.provider || 'gemini',
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
app.get('/api/archive/search', async (req, res) => {
  const { q, type = 'all' } = req.query;
  if (!q || !q.trim()) {
    return res.json([]);
  }

  try {
    let queryVector = null;
    try {
      queryVector = await embeddingService.getVector(q);
    } catch (_) {}

    const [messages, obsidianNotes] = await Promise.all([
      (type === 'all' || type === 'messages') 
        ? hybridSearch.searchMessages(q, queryVector, { limit: 30 }) 
        : Promise.resolve([]),
      (type === 'all' || type === 'obsidian')
        ? hybridSearch.searchObsidianNotes(q, queryVector, 20)
        : Promise.resolve([])
    ]);

    const formattedMessages = messages.map(m => ({
      ...m,
      result_type: 'message'
    }));

    const keywords = hybridSearch.extractKeywords(q);
    const formattedNotes = obsidianNotes.map(n => ({
      ...n,
      content: n.preview || (n.content ? hybridSearch.extractCenteredSnippet(n.content, keywords, 500) : ''),
      result_type: 'obsidian_note',
      conversation_id: null,
      conversation_title: n.title,
      role: 'note',
      timestamp: n.created_at || n.updated_at || (n.mtime_ms ? new Date(n.mtime_ms).toISOString() : new Date().toISOString())
    }));

    // Combine results: matching notes + messages
    const combined = [...formattedNotes, ...formattedMessages];
    res.json(combined);
  } catch (err) {
    res.status(400).json({ error: 'Search failed: ' + err.message });
  }
});

// -------------------------------------------------------------
// Visual Mind Map Graph Endpoint
// -------------------------------------------------------------
app.get('/api/visualize/mindmap', async (req, res) => {
  const { q = '', maxNodes = 45 } = req.query;
  try {
    const graph = await mindmapService.buildGraph(q, { maxNodes: parseInt(maxNodes, 10) || 45 });
    res.json(graph);
  } catch (err) {
    console.error('[MindMap Error]:', err);
    res.status(500).json({ error: err.message || 'Failed to generate mind map graph' });
  }
});

// -------------------------------------------------------------
// Embeddings Management Endpoints
// -------------------------------------------------------------
app.get('/api/embeddings/status', (req, res) => {
  res.json(embeddingService.getStatus());
});

app.post('/api/embeddings/backfill', async (req, res) => {
  try {
    const result = await embeddingService.backfillBatch(req.body?.batchSize || 100);
    res.json({ success: true, ...result, status: embeddingService.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
// Summarization & Search Digest Endpoints
// -------------------------------------------------------------
app.get('/api/digests/preview', (req, res) => {
  const { mode = 'incremental' } = req.query;
  const pending = summarizer.getPendingCounts(mode);
  const summarizerConf = summarizer.getSummarizerConfig();
  res.json({ ...pending, config: summarizerConf });
});

app.get('/api/digests', (req, res) => {
  const { corpus } = req.query;
  let query = 'SELECT * FROM archive_digests WHERE is_deleted = 0';
  const params = [];
  if (corpus && corpus !== 'all') {
    query += ' AND corpus_type = ?';
    params.push(corpus);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({
    ...r,
    entities: (() => { try { return JSON.parse(r.entities_json || '[]'); } catch (_) { return []; } })(),
    references: (() => { try { return JSON.parse(r.references_json || '[]'); } catch (_) { return []; } })()
  })));
});

app.post('/api/digests/generate', async (req, res) => {
  const { corpus = 'all', mode = 'incremental', overrideProvider, overrideModel, apiKey } = req.body || {};
  try {
    const result = await summarizer.runSummarization({ corpus, mode, overrideProvider, overrideModel, apiKey });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backward-compatibility endpoints for existing frontend calls
app.get('/api/summaries/preview', (req, res) => {
  const { mode = 'incremental' } = req.query;
  const pending = summarizer.getPendingCounts(mode);
  const summarizerConf = summarizer.getSummarizerConfig();
  res.json({ count: pending.ai_conversations.count, ...pending, config: summarizerConf });
});

app.get('/api/categories', (req, res) => {
  // Scrapped category system: return empty array for clean backwards-compatibility
  res.json([]);
});

app.get('/api/summaries', (req, res) => {
  const { corpus } = req.query;
  let query = 'SELECT * FROM archive_digests WHERE is_deleted = 0';
  const params = [];
  if (corpus && corpus !== 'all') {
    query += ' AND corpus_type = ?';
    params.push(corpus);
  }
  query += ' ORDER BY created_at DESC';
  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({
    ...r,
    entities: (() => { try { return JSON.parse(r.entities_json || '[]'); } catch (_) { return []; } })(),
    references: (() => { try { return JSON.parse(r.references_json || '[]'); } catch (_) { return []; } })()
  })));
});

app.get('/api/summaries/global', (req, res) => {
  const global = db.prepare(`
    SELECT * FROM archive_digests 
    WHERE (title LIKE '%global%' OR corpus_type = 'unified') AND is_deleted = 0 
    ORDER BY created_at DESC LIMIT 1
  `).get() || db.prepare(`
    SELECT * FROM archive_digests 
    WHERE is_deleted = 0 
    ORDER BY created_at DESC LIMIT 1
  `).get();
  
  if (global) {
    global.entities = (() => { try { return JSON.parse(global.entities_json || '[]'); } catch (_) { return []; } })();
    global.references = (() => { try { return JSON.parse(global.references_json || '[]'); } catch (_) { return []; } })();
  }
  res.json(global || null);
});

app.post('/api/summaries/generate', async (req, res) => {
  const { corpus = 'all', mode = 'incremental', overrideProvider, overrideModel, apiKey } = req.body || {};
  try {
    const result = await summarizer.runSummarization({ corpus, mode, overrideProvider, overrideModel, apiKey });
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
      const scanDir = (dir, prefix = 'Summaries') => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, `${prefix}/${entry.name}`);
          } else if (entry.name.endsWith('.md')) {
            const zipPath = `${prefix}/${entry.name}`;
            archive.file(fullPath, { name: zipPath });
            addedSummaries.add(zipPath.toLowerCase());
          }
        }
      };
      scanDir(SUMMARIES_DIR);
    }

    // Include database digests if not already added
    const dbDigests = db.prepare(`SELECT * FROM archive_digests WHERE is_deleted = 0`).all();
    for (const d of dbDigests) {
      const folder = d.corpus_type === 'obsidian_notes' ? 'Summaries/Obsidian_Notes' : 'Summaries/AI_Conversations';
      const safeName = d.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) + '.md';
      const zipPath = `${folder}/${safeName}`;
      if (!addedSummaries.has(zipPath.toLowerCase())) {
        const entJson = (() => { try { return JSON.parse(d.entities_json || '[]'); } catch (_) { return []; } })();
        const refJson = (() => { try { return JSON.parse(d.references_json || '[]'); } catch (_) { return []; } })();
        const entMd = entJson.map(e => `\`${e}\``).join(' ');
        const refMd = refJson.map(r => `- [[${r.title || r.rel_path}]](id:${r.id || r.rel_path})`).join('\n');
        const content = `---
title: "${d.title.replace(/"/g, '\\"')}"
corpus: "${d.corpus_type}"
updated: "${d.updated_at || d.created_at}"
---

# ${d.title}

${d.summary_text}

### 🏷️ Indexed Entities
${entMd}

### 🔗 Provenance References
${refMd}
`;
        archive.append(content, { name: zipPath });
        addedSummaries.add(zipPath.toLowerCase());
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
  const attachments = db.prepare('SELECT * FROM attachments WHERE is_deleted = 0').all();

  res.setHeader('Content-Disposition', 'attachment; filename="personal_ai_archive_backup.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ 
    version: '1.0',
    exported_at: new Date().toISOString(),
    conversations, 
    messages, 
    categories, 
    summaries,
    attachments
  }, null, 2));
});

// Multer memory storage for JSON backup restoration
const jsonBackupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' || file.originalname.toLowerCase().endsWith('.json')) {
      cb(null, true);
    } else {
      cb(new Error('Only .json backup files are permitted'));
    }
  }
});

function parseBackupPayload(req) {
  let backupData;
  if (req.file) {
    const jsonStr = req.file.buffer.toString('utf-8');
    backupData = JSON.parse(jsonStr);
  } else if (req.body && (req.body.conversations || req.body.messages || req.body.data)) {
    backupData = req.body.data || req.body;
  } else if (req.body && typeof req.body === 'object') {
    backupData = req.body;
  }

  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid backup file: Payload must be a JSON object');
  }

  return backupData;
}

function restoreJsonBackup({ backupData, mode = 'merge' }) {
  const conversations = Array.isArray(backupData.conversations) ? backupData.conversations : [];
  const messages = Array.isArray(backupData.messages) ? backupData.messages : [];
  const categories = Array.isArray(backupData.categories) ? backupData.categories : [];
  const summaries = Array.isArray(backupData.summaries) ? backupData.summaries : [];
  const attachments = Array.isArray(backupData.attachments) ? backupData.attachments : [];

  if (conversations.length === 0 && messages.length === 0) {
    throw new Error('Invalid backup file: No conversations or messages found to restore');
  }

  const counts = {
    conversations: 0,
    messages: 0,
    categories: 0,
    summaries: 0,
    attachments: 0
  };

  const executeRestore = db.transaction(() => {
    if (mode === 'replace') {
      // Clean restore: wipe existing conversations and summaries while preserving settings
      db.prepare('DELETE FROM attachments').run();
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM conversations').run();
      db.prepare('DELETE FROM archive_summaries').run();
      db.prepare('DELETE FROM categories').run();
    }

    // 1. Categories
    const upsertCat = db.prepare(`
      INSERT INTO categories (id, name, description, created_at, updated_at, device_id, is_deleted)
      VALUES (@id, @name, @description, @created_at, @updated_at, @device_id, @is_deleted)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
    `);
    for (const cat of categories) {
      if (!cat.id || !cat.name) continue;
      try {
        upsertCat.run({
          id: cat.id,
          name: cat.name,
          description: cat.description || null,
          created_at: cat.created_at || new Date().toISOString(),
          updated_at: cat.updated_at || new Date().toISOString(),
          device_id: cat.device_id || 'restored_instance',
          is_deleted: cat.is_deleted ? 1 : 0
        });
        counts.categories++;
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed: categories.name')) {
          db.prepare('UPDATE categories SET description = COALESCE(@description, description), updated_at = @updated_at WHERE name = @name')
            .run({
              name: cat.name,
              description: cat.description || null,
              updated_at: cat.updated_at || new Date().toISOString()
            });
          counts.categories++;
        } else {
          console.warn('[Restore] Skipped category:', cat.id, err.message);
        }
      }
    }

    // 2. Conversations
    const upsertConv = db.prepare(`
      INSERT INTO conversations (id, title, created_at, updated_at, device_id, is_deleted, default_provider, default_model)
      VALUES (@id, @title, @created_at, @updated_at, @device_id, @is_deleted, @default_provider, @default_model)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted,
        default_provider = COALESCE(excluded.default_provider, conversations.default_provider),
        default_model = COALESCE(excluded.default_model, conversations.default_model)
    `);
    const knownConvIds = new Set();
    for (const conv of conversations) {
      if (!conv.id) continue;
      upsertConv.run({
        id: conv.id,
        title: conv.title || 'Untitled Conversation',
        created_at: conv.created_at || new Date().toISOString(),
        updated_at: conv.updated_at || new Date().toISOString(),
        device_id: conv.device_id || 'restored_instance',
        is_deleted: conv.is_deleted ? 1 : 0,
        default_provider: conv.default_provider || conv.provider || null,
        default_model: conv.default_model || conv.model || null
      });
      knownConvIds.add(conv.id);
      counts.conversations++;
    }

    // 3. Messages
    const ensureConv = db.prepare(`
      INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at, device_id, is_deleted)
      VALUES (?, 'Restored Conversation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'restored_instance', 0)
    `);
    const upsertMsg = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, status, timestamp, updated_at, device_id, is_deleted, provider, model, metadata_json, post_type)
      VALUES (@id, @conversation_id, @role, @content, @status, @timestamp, @updated_at, @device_id, @is_deleted, @provider, @model, @metadata_json, @post_type)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        status = excluded.status,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted,
        provider = excluded.provider,
        model = excluded.model,
        metadata_json = excluded.metadata_json,
        post_type = excluded.post_type
    `);
    for (const msg of messages) {
      if (!msg.id || !msg.conversation_id) continue;
      if (!knownConvIds.has(msg.conversation_id)) {
        ensureConv.run(msg.conversation_id);
        knownConvIds.add(msg.conversation_id);
      }
      upsertMsg.run({
        id: msg.id,
        conversation_id: msg.conversation_id,
        role: msg.role || 'user',
        content: msg.content || '',
        status: msg.status || 'completed',
        timestamp: msg.timestamp || new Date().toISOString(),
        updated_at: msg.updated_at || new Date().toISOString(),
        device_id: msg.device_id || 'restored_instance',
        is_deleted: msg.is_deleted ? 1 : 0,
        provider: msg.provider || null,
        model: msg.model || null,
        metadata_json: typeof msg.metadata_json === 'object' ? JSON.stringify(msg.metadata_json) : (msg.metadata_json || null),
        post_type: msg.post_type || 'user'
      });
      counts.messages++;
    }

    // 4. Attachments (if present)
    const upsertAtt = db.prepare(`
      INSERT INTO attachments (id, message_id, file_name, file_path, mime_type, file_size, checksum, created_at, updated_at, is_deleted)
      VALUES (@id, @message_id, @file_name, @file_path, @mime_type, @file_size, @checksum, @created_at, @updated_at, @is_deleted)
      ON CONFLICT(id) DO UPDATE SET
        file_name = excluded.file_name,
        file_path = excluded.file_path,
        is_deleted = excluded.is_deleted
    `);
    for (const att of attachments) {
      if (!att.id || !att.message_id) continue;
      try {
        upsertAtt.run({
          id: att.id,
          message_id: att.message_id,
          file_name: att.file_name || 'attachment',
          file_path: att.file_path || '',
          mime_type: att.mime_type || 'image/jpeg',
          file_size: att.file_size || 0,
          checksum: att.checksum || '',
          created_at: att.created_at || new Date().toISOString(),
          updated_at: att.updated_at || new Date().toISOString(),
          is_deleted: att.is_deleted ? 1 : 0
        });
        counts.attachments++;
      } catch (err) {
        console.warn('[Restore] Skipped attachment:', att.id, err.message);
      }
    }

    // 5. Summaries
    const ensureCat = db.prepare(`
      INSERT OR IGNORE INTO categories (id, name, created_at, updated_at, device_id, is_deleted)
      VALUES (?, 'Restored Topic', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'restored_instance', 0)
    `);
    const upsertSummary = db.prepare(`
      INSERT INTO archive_summaries (id, category_id, summary_text, coverage_start, coverage_end, created_at, updated_at, device_id, is_deleted, summary_type)
      VALUES (@id, @category_id, @summary_text, @coverage_start, @coverage_end, @created_at, @updated_at, @device_id, @is_deleted, @summary_type)
      ON CONFLICT(id) DO UPDATE SET
        summary_text = excluded.summary_text,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
    `);
    for (const sum of summaries) {
      if (!sum.id) continue;
      if (sum.category_id) {
        ensureCat.run(sum.category_id);
      }
      try {
        upsertSummary.run({
          id: sum.id,
          category_id: sum.category_id || null,
          summary_text: sum.summary_text || '',
          coverage_start: sum.coverage_start || null,
          coverage_end: sum.coverage_end || null,
          created_at: sum.created_at || new Date().toISOString(),
          updated_at: sum.updated_at || new Date().toISOString(),
          device_id: sum.device_id || 'restored_instance',
          is_deleted: sum.is_deleted ? 1 : 0,
          summary_type: sum.summary_type || (sum.category_id ? 'category' : 'global')
        });
        counts.summaries++;
      } catch (err) {
        console.warn('[Restore] Skipped summary:', sum.id, err.message);
      }
    }

    // 6. Rebuild FTS5 virtual table
    db.prepare("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").run();
  });

  executeRestore();

  return {
    success: true,
    mode,
    counts,
    message: `Successfully restored ${counts.conversations} conversations, ${counts.messages} messages, and ${counts.categories} topics.`
  };
}

// Endpoint to preview backup contents without modifying database
app.post('/api/restore/preview', jsonBackupUpload.single('file'), (req, res) => {
  try {
    const backupData = parseBackupPayload(req);
    const conversations = Array.isArray(backupData.conversations) ? backupData.conversations : [];
    const messages = Array.isArray(backupData.messages) ? backupData.messages : [];
    const categories = Array.isArray(backupData.categories) ? backupData.categories : [];
    const summaries = Array.isArray(backupData.summaries) ? backupData.summaries : [];
    const attachments = Array.isArray(backupData.attachments) ? backupData.attachments : [];

    res.json({
      valid: conversations.length > 0 || messages.length > 0,
      version: backupData.version || '1.0',
      exported_at: backupData.exported_at || null,
      counts: {
        conversations: conversations.length,
        messages: messages.length,
        categories: categories.length,
        summaries: summaries.length,
        attachments: attachments.length
      },
      previewConversations: conversations.slice(0, 5).map(c => ({
        id: c.id,
        title: c.title || 'Untitled Conversation',
        updated_at: c.updated_at
      }))
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Failed to inspect backup file' });
  }
});

// Endpoint to restore backup into database
app.post('/api/restore/json', jsonBackupUpload.single('file'), (req, res) => {
  try {
    const backupData = parseBackupPayload(req);
    const mode = (req.body && req.body.mode === 'replace') ? 'replace' : 'merge';
    const result = restoreJsonBackup({ backupData, mode });
    res.json(result);
  } catch (err) {
    console.error('[Restore Backup Error]:', err);
    res.status(400).json({ error: err.message || 'Failed to restore backup' });
  }
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
    const { q = '', limit = 500 } = req.query;
    const notes = obsidianSync.searchNotes(q, parseInt(limit, 10) || 500);
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

module.exports = { app, server };
