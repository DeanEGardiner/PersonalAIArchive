const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, SUMMARIES_DIR } = require('./db');
const providerRouter = require('./providers');
const config = require('./config');

class SummarizerService {
  getSummarizerConfig() {
    const onlyPrivate = config.getSetting('only_private_ai_summarization') === 'true';
    let provider = config.getSetting('summarizer_provider') || 'ollama';
    let model = config.getSetting('summarizer_model') || config.DEFAULT_MODELS.ollama;

    if (onlyPrivate && !config.isLocalProvider(provider)) {
      provider = 'ollama';
    }

    return { onlyPrivate, provider, model };
  }

  getPendingMessagesCount(mode = 'incremental') {
    if (mode === 'incremental') {
      const latestSummary = db.prepare(`
        SELECT MAX(coverage_end) as last_coverage FROM archive_summaries WHERE is_deleted = 0
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

  async runSummarization({ mode = 'incremental', overrideProvider, overrideModel, apiKey }) {
    const summarizerConfig = this.getSummarizerConfig();
    let provider = overrideProvider || summarizerConfig.provider;

    // Enforce privacy constraint
    if (summarizerConfig.onlyPrivate && !config.isLocalProvider(provider)) {
      console.warn(`[Summarizer] Only private AI summarization is enabled. Forcing local provider instead of '${provider}'.`);
      provider = 'ollama';
    }

    const model = overrideModel || (provider === summarizerConfig.provider ? summarizerConfig.model : config.DEFAULT_MODELS[provider]);
    const resolvedApiKey = apiKey || config.getApiKey(provider);

    // Fetch messages to process
    let messages = [];
    let coverageStart = null;
    let coverageEnd = null;

    if (mode === 'incremental') {
      const latestSummary = db.prepare(`
        SELECT MAX(coverage_end) as last_coverage FROM archive_summaries WHERE is_deleted = 0
      `).get();
      const lastTimestamp = latestSummary?.last_coverage || '1970-01-01T00:00:00';

      messages = db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.timestamp > ? AND m.is_deleted = 0
        ORDER BY m.timestamp ASC
      `).all(lastTimestamp);
    } else {
      messages = db.prepare(`
        SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.title as conversation_title
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE m.is_deleted = 0
        ORDER BY m.timestamp ASC
      `).all();
    }

    if (messages.length === 0) {
      return { success: true, processedCount: 0, message: 'No new messages to summarize.' };
    }

    coverageStart = messages[0].timestamp;
    coverageEnd = messages[messages.length - 1].timestamp;

    // Compact history representation for the model
    const conversationArchiveText = messages.map(m => 
      `[${m.timestamp}] [${m.conversation_title || 'Untitled'}] ${m.role.toUpperCase()}: ${m.content.slice(0, 500)}`
    ).join('\n');

    const prompt = `You are a personal knowledge management assistant. Analyze the following conversation archive log from the user's AI chats.

Instructions:
1. Identify major thematic categories (e.g. "Software Architecture", "Health & Nutrition", "Writing", "Daily Planning").
2. For each category:
   - Provide a concise name and brief description.
   - Summarize the key discussions, chronological milestones, decisions, and concrete recommendations made.
   - List the IDs or titles of relevant conversations.
3. Provide a high-level Global Executive Summary of the user's overall recent interests and themes.

Return ONLY a valid JSON object matching this schema without markdown fences:
{
  "global_summary": "High-level digest of all interactions...",
  "categories": [
    {
      "name": "Category Name",
      "description": "Brief scope...",
      "summary_text": "Detailed summary with key conclusions and recommendations...",
      "key_recommendations": ["Recommendation 1", "Recommendation 2"]
    }
  ]
}

Conversation Archive:
${conversationArchiveText}`;

    console.log(`[Summarizer] Running summarization (mode=${mode}, provider=${provider}, model=${model})...`);
    let jsonResponse = '';
    await providerRouter.streamChat({
      provider,
      model,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You are an expert AI knowledge archivist. You must output ONLY a valid JSON object matching the requested schema. Do not output markdown fences or commentary.',
      apiKey: resolvedApiKey,
      jsonMode: true,
      onChunk: (chunk) => { jsonResponse += chunk; }
    });

    let resultData;
    try {
      if (!jsonResponse || !jsonResponse.trim()) {
        throw new Error('AI provider returned an empty response.');
      }

      // Strip think tags
      let cleaned = jsonResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

      // Remove markdown code fences if present
      const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (fenceMatch && fenceMatch[1]) {
        cleaned = fenceMatch[1].trim();
      }

      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }

      try {
        resultData = JSON.parse(cleaned);
      } catch (_) {
        const withoutTrailingCommas = cleaned.replace(/,\s*([}\]])/g, '$1');
        resultData = JSON.parse(withoutTrailingCommas);
      }
    } catch (err) {
      console.error('[Summarizer Error] Failed to parse AI response. Raw output:\n', jsonResponse);
      throw new Error(`Failed to parse AI summarizer response as JSON: ${err.message}. Response preview: ${jsonResponse.slice(0, 150)}`);
    }

    if (!resultData || typeof resultData !== 'object') {
      throw new Error('AI summarizer returned invalid data structure.');
    }

    if (!resultData.global_summary && !resultData.categories) {
      resultData = {
        global_summary: typeof resultData === 'string' ? resultData : JSON.stringify(resultData),
        categories: []
      };
    }

    // Save Categories & Summaries to SQLite (with upsert/soft-delete of older versions)
    const now = new Date().toISOString();
    const filesToWrite = [];

    db.transaction(() => {
      // 1. Global summary
      if (resultData.global_summary) {
        // Mark previous active global summary as deleted
        db.prepare(`UPDATE archive_summaries SET is_deleted = 1 WHERE summary_type = 'global' AND is_deleted = 0`).run();

        const globalSummaryId = uuidv4();
        db.prepare(`
          INSERT INTO archive_summaries (id, summary_text, coverage_start, coverage_end, summary_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'global', ?, ?)
        `).run(globalSummaryId, resultData.global_summary, coverageStart, coverageEnd, now, now);

        filesToWrite.push({
          path: path.join(SUMMARIES_DIR, 'Global_Archive_Digest.md'),
          content: `---
title: "Global Archive Digest"
updated: "${now}"
coverage_start: "${coverageStart}"
coverage_end: "${coverageEnd}"
source: "Personal AI Archive"
---

# Global AI Archive Digest

${resultData.global_summary}
`
        });
      }

      // 2. Categories
      for (const cat of (resultData.categories || [])) {
        let categoryRecord = db.prepare('SELECT id FROM categories WHERE name = ?').get(cat.name);
        let categoryId = categoryRecord?.id;

        if (!categoryId) {
          categoryId = uuidv4();
          db.prepare(`
            INSERT INTO categories (id, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(categoryId, cat.name, cat.description || '', now, now);
        }

        // Mark previous active summary for this category as deleted
        db.prepare(`UPDATE archive_summaries SET is_deleted = 1 WHERE category_id = ? AND is_deleted = 0`).run(categoryId);

        const summaryId = uuidv4();
        db.prepare(`
          INSERT INTO archive_summaries (id, category_id, summary_text, coverage_start, coverage_end, summary_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'category', ?, ?)
        `).run(summaryId, categoryId, cat.summary_text, coverageStart, coverageEnd, now, now);

        const safeFilename = cat.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md';
        const recsMarkdown = (cat.key_recommendations || []).map(r => `- ${r}`).join('\n');

        filesToWrite.push({
          path: path.join(SUMMARIES_DIR, safeFilename),
          content: `---
category: "${cat.name}"
updated: "${now}"
coverage_start: "${coverageStart}"
coverage_end: "${coverageEnd}"
source: "Personal AI Archive"
---

# ${cat.name}

${cat.description ? `*${cat.description}*\n` : ''}
## Summary & Decisions
${cat.summary_text}

${recsMarkdown ? `## Key Recommendations\n${recsMarkdown}\n` : ''}
`
        });
      }
    })();

    // Write markdown files on disk after DB transaction commits
    for (const f of filesToWrite) {
      try {
        fs.writeFileSync(f.path, f.content, 'utf8');
      } catch (err) {
        console.warn(`[Summarizer] Failed to write summary file ${f.path}:`, err.message);
      }
    }

    return {
      success: true,
      processedCount: messages.length,
      categoriesCount: (resultData.categories || []).length,
      coverageStart,
      coverageEnd
    };
  }
}

module.exports = new SummarizerService();
