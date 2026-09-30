require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { ZipArchive } = require('archiver');

const { db, SUMMARIES_DIR, MEDIA_DIR } = require('./db');
const providerRouter = require('./providers');
const summarizer = require('./summarizer');
const contextInjector = require('./contextInjector');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// Serve summaries directory for direct file viewing if desired
app.use('/summaries-files', express.static(SUMMARIES_DIR));

// -------------------------------------------------------------
// Provider Health & Models Endpoint
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
// Settings Endpoints
// -------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const updates = req.body;
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const [k, v] of Object.entries(updates)) {
      upsert.run(k, String(v));
    }
  })();
  res.json({ success: true });
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
  const { title, provider, model } = req.body;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (id, title, default_provider, default_model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title || 'New Conversation', provider || 'ollama', model || 'gemma4:12b-mlx', now, now);

  res.json({ id, title: title || 'New Conversation' });
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
  res.json({ ...conv, messages });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const messages = db.prepare(`
    SELECT * FROM messages 
    WHERE conversation_id = ? AND is_deleted = 0
    ORDER BY timestamp ASC
  `).all(id);
  res.json(messages);
});

// Direct message creation into a conversation
app.post('/api/conversations/:id/messages', (req, res) => {
  const { id } = req.params;
  const { role = 'assistant', content, provider = 'gemini', model = 'gemini-3.6-flash' } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Message content cannot be empty' });
  }

  const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND is_deleted = 0').get(id);
  if (!conv) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const msgId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, status, provider, model, timestamp, updated_at)
    VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)
  `).run(msgId, id, role, content, provider, model, now, now);

  db.prepare(`
    INSERT INTO messages_fts (content, conversation_id, message_id, role, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(content, id, msgId, role, now);

  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, id);

  res.json({
    id: msgId,
    conversation_id: id,
    role,
    content,
    status: 'completed',
    provider,
    model,
    timestamp: now
  });
});

// -------------------------------------------------------------
// Google Search AI Endpoint (Powered by Gemini Grounding)
// -------------------------------------------------------------
app.post('/api/search/ai', async (req, res) => {
  const { query, model = 'gemini-3.6-flash' } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Search query cannot be empty' });
  }

  const geminiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const apiKey = geminiKeySetting?.value || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({ 
      error: 'Google Gemini API key is missing. Please configure your Gemini API Key in Settings to use Google Search AI.' 
    });
  }

  try {
    const searchResult = await providerRouter.googleSearchAI({
      query: query.trim(),
      model,
      apiKey
    });

    res.json({
      success: true,
      query: query.trim(),
      summary: searchResult.text,
      sources: searchResult.sources,
      searchQueries: searchResult.searchQueries,
      model: searchResult.model
    });
  } catch (err) {
    console.error('[Google Search AI Error]:', err);
    res.status(500).json({ error: err.message || 'Failed to complete Google Search AI request.' });
  }
});

// -------------------------------------------------------------
// URL Summary Endpoint (AI Web Page Summary)
// -------------------------------------------------------------
app.post('/api/summarize-url', async (req, res) => {
  const { url, model = 'gemini-3.6-flash' } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const geminiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const apiKey = geminiKeySetting?.value || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({ 
      error: 'Google Gemini API key is missing. Please configure your Gemini API Key in Settings to generate AI web summaries.' 
    });
  }

  try {
    const result = await providerRouter.summarizeURL({
      url: url.trim(),
      model,
      apiKey
    });

    res.json({
      success: true,
      url: result.url,
      title: result.title,
      summary: result.summary,
      model
    });
  } catch (err) {
    console.error('[URL Summary Error]:', err);
    res.status(500).json({ error: err.message || 'Failed to summarize web page.' });
  }
});

// -------------------------------------------------------------
// Chat Streaming Endpoint with Abort & Auto-Archiving
// -------------------------------------------------------------
app.post(['/api/chat', '/api/chat/stream'], async (req, res) => {
  const { 
    conversationId, 
    userMessage,
    message,
    provider = 'ollama', 
    model = 'gemma4:12b-mlx', 
    useArchiveData = false,
    injectContext = false,
    categoryIds = []
  } = req.body;

  const actualMessage = userMessage || message;
  if (!actualMessage || !actualMessage.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }

  let activeConvId = conversationId;
  const now = new Date().toISOString();

  // Create conversation if none provided
  if (!activeConvId) {
    activeConvId = uuidv4();
    const cleanTitle = actualMessage.slice(0, 40) + (actualMessage.length > 40 ? '...' : '');
    db.prepare(`
      INSERT INTO conversations (id, title, default_provider, default_model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(activeConvId, cleanTitle, provider, model, now, now);
  } else {
    // If conversation already exists but still has default title (e.g. "New Conversation"), update it with first query
    const existingConv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(activeConvId);
    if (existingConv && (!existingConv.title || existingConv.title === 'New Conversation' || existingConv.title === 'Untitled Conversation')) {
      const cleanTitle = actualMessage.slice(0, 40) + (actualMessage.length > 40 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(cleanTitle, now, activeConvId);
      console.log(`[Chat Checkpoint] Updated conversation title for ${activeConvId} to: "${cleanTitle}"`);
    }
  }

  console.log(`\n========================================`);
  console.log(`[Chat Request] Active Conv: ${activeConvId}, Provider: ${provider}, Model: ${model}`);
  console.log(`[Chat Request] Message: "${actualMessage.slice(0, 80)}${actualMessage.length > 80 ? '...' : ''}"`);
  console.log(`[Chat Request] Archive Injection: ${useArchiveData || injectContext ? 'ON' : 'OFF'}`);
  console.log(`========================================`);

  // 1. Persist User Message Immediately
  const userMsgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, provider, model, timestamp, updated_at)
    VALUES (?, ?, 'user', ?, ?, ?, ?, ?)
  `).run(userMsgId, activeConvId, actualMessage, provider, model, now, now);

  // Sync to FTS5 index
  db.prepare(`
    INSERT INTO messages_fts (content, conversation_id, message_id, role, timestamp)
    VALUES (?, ?, ?, 'user', ?)
  `).run(actualMessage, activeConvId, userMsgId, now);

  // 2. Build Context if Archive Data checkbox is enabled
  let systemPrompt = null;
  if (useArchiveData || injectContext) {
    console.log(`[Chat Checkpoint] Building archive context for query...`);
    systemPrompt = contextInjector.buildContext({
      userQuery: actualMessage,
      categoryIds
    });
    console.log(`[Chat Checkpoint] Archive context built. Size: ${systemPrompt ? systemPrompt.length : 0} chars`);
  }

  // 3. Prepare Chat History
  const history = db.prepare(`
    SELECT role, content FROM messages
    WHERE conversation_id = ? AND is_deleted = 0
    ORDER BY timestamp ASC
  `).all(activeConvId);

  console.log(`[Chat Checkpoint] Conversation history loaded (${history.length} messages)`);

  // Setup SSE Streaming Response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send conversation info header
  res.write(`data: ${JSON.stringify({ type: 'init', conversationId: activeConvId, userMessageId: userMsgId })}\n\n`);

  const abortController = new AbortController();
  // CRITICAL FIX: Only abort if response stream closes before completing (e.g. client clicked Stop or navigated away)
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`[Chat Checkpoint] Client disconnected/aborted prematurely.`);
      abortController.abort();
    }
  });

  const assistantMsgId = uuidv4();
  let fullAssistantText = '';
  let status = 'completed';
  let chunkCount = 0;

  try {
    console.log(`[Chat Checkpoint] Calling providerRouter.streamChat with provider='${provider}', model='${model}'...`);
    // Read API keys from settings if not in env
    const openAiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get();
    const geminiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();

    await providerRouter.streamChat({
      provider,
      model,
      messages: history,
      systemPrompt,
      apiKey: provider === 'openai' ? (openAiKeySetting?.value || process.env.OPENAI_API_KEY) : (geminiKeySetting?.value || process.env.GEMINI_API_KEY),
      abortSignal: abortController.signal,
      onChunk: (chunk) => {
        chunkCount++;
        fullAssistantText += chunk;
        if (chunkCount === 1) {
          console.log(`[Chat Checkpoint] First token received from ${provider} (${model})!`);
        }
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      }
    });
    console.log(`[Chat Checkpoint] Stream finished successfully. Received ${chunkCount} chunks, total chars: ${fullAssistantText.length}`);
  } catch (err) {
    if (abortController.signal.aborted) {
      status = 'interrupted';
      console.log(`[Chat Checkpoint] Stream was interrupted by client.`);
    } else {
      status = 'error';
      console.error(`[Chat Error] Provider error from ${provider}:`, err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    }
  } finally {
    const endNow = new Date().toISOString();
    // Persist Assistant Response (full or partial/interrupted)
    if (fullAssistantText.trim().length > 0) {
      console.log(`[Chat Checkpoint] Saving assistant response (${fullAssistantText.length} chars, status='${status}') to SQLite database...`);
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, content, status, provider, model, timestamp, updated_at)
        VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)
      `).run(assistantMsgId, activeConvId, fullAssistantText, status, provider, model, endNow, endNow);

      db.prepare(`
        INSERT INTO messages_fts (content, conversation_id, message_id, role, timestamp)
        VALUES (?, ?, ?, 'assistant', ?)
      `).run(fullAssistantText, activeConvId, assistantMsgId, endNow);

      // Update conversation timestamp & provider/model
      db.prepare('UPDATE conversations SET default_provider = ?, default_model = ?, updated_at = ? WHERE id = ?')
        .run(provider, model, endNow, activeConvId);
      console.log(`[Chat Checkpoint] Assistant response persisted and indexed.`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', conversationId: activeConvId, assistantMessageId: assistantMsgId, status })}\n\n`);
    res.end();
  }
});

// -------------------------------------------------------------
// Archive Explorer & Search Endpoints
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
      JOIN messages m ON fts.message_id = m.id
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
  const messages = db.prepare(`
    SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, m.provider, m.model, c.title as conversation_title
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE m.is_deleted = 0
    ORDER BY m.timestamp DESC
    LIMIT 100
  `).all();
  res.json(messages);
});

// -------------------------------------------------------------
// Summarization & Category Endpoints
// -------------------------------------------------------------
app.get('/api/summaries/preview', (req, res) => {
  const { mode = 'incremental' } = req.query;
  const preview = summarizer.getPendingMessagesCount(mode);
  const config = summarizer.getSummarizerConfig();
  res.json({ ...preview, config });
});

app.get('/api/categories', (req, res) => {
  const categories = db.prepare(`
    SELECT c.*, 
      (SELECT summary_text FROM archive_summaries WHERE category_id = c.id ORDER BY created_at DESC LIMIT 1) as latest_summary,
      (SELECT coverage_end FROM archive_summaries WHERE category_id = c.id ORDER BY created_at DESC LIMIT 1) as last_updated
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
  const { mode = 'incremental', overrideProvider, overrideModel, apiKey } = req.body;
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

    // Track added summary files to avoid zip duplicate entry issues
    const addedSummaries = new Set();

    // 1. Add generated summary markdown files from SUMMARIES_DIR
    if (fs.existsSync(SUMMARIES_DIR)) {
      const summaryFiles = fs.readdirSync(SUMMARIES_DIR).filter(f => f.endsWith('.md'));
      for (const file of summaryFiles) {
        const filePath = path.join(SUMMARIES_DIR, file);
        archive.file(filePath, { name: `Summaries/${file}` });
        addedSummaries.add(file.toLowerCase());
      }
    }

    // Include database summaries if not already on disk
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
    const tagsStmt = db.prepare(`
      SELECT DISTINCT c.name FROM categories c
      JOIN message_categories mc ON mc.category_id = c.id
      JOIN messages m ON m.id = mc.message_id
      WHERE m.conversation_id = ? AND c.is_deleted = 0
    `);

    const usedFilenames = new Set();
    const convIndexList = [];

    for (const conv of conversations) {
      const msgs = messageStmt.all(conv.id);
      const tags = tagsStmt.all(conv.id).map(r => r.name);

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
        messageCount: msgs.length,
        tags
      });

      // Frontmatter & Body
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
        ...tags.map(t => `  - "${t.replace(/"/g, '\\"')}"`),
        '---',
        '',
        ''
      ].join('\n');

      let body = `# ${conv.title || 'Untitled Conversation'}\n\n`;
      body += `- **Created:** ${conv.created_at || 'Unknown'}\n`;
      body += `- **Provider:** ${(conv.default_provider || 'AI').toUpperCase()} | **Model:** ${conv.default_model || 'default'}\n`;
      if (tags.length > 0) {
        body += `- **Topics:** ${tags.map(t => `\`#${t}\``).join(' ')}\n`;
      }
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
// Serve Frontend (Vite build output)
// -------------------------------------------------------------
const CLIENT_DIST = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/summaries-files')) {
      return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    }
    next();
  });
}

// Start Express Server
app.listen(PORT, () => {
  console.log(`Personal AI Archive server running on http://localhost:${PORT}`);
});

