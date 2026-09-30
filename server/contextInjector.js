const { db } = require('./db');

class ContextInjector {
  /**
   * Build structured archive memory context to satisfy temporal meta-queries
   * such as "When did we discuss X?" and "What were the recommendations?"
   */
  buildContext({ userQuery, categoryIds = [], scope = 'auto', maxTokens = 1500 }) {
    let contextSections = [];

    // 1. Check if user is asking temporal/meta questions
    const isTemporalQuery = /\b(when|previous|history|recommendation|earlier|past|before|last time|did we)\b/i.test(userQuery);

    // 2. Fetch Latest Global Digest
    const globalSummary = db.prepare(`
      SELECT summary_text, coverage_start, coverage_end, updated_at
      FROM archive_summaries
      WHERE summary_type = 'global' AND is_deleted = 0
      ORDER BY coverage_end DESC LIMIT 1
    `).get();

    if (globalSummary) {
      contextSections.push(`### Global Archive Digest (Covering ${globalSummary.coverage_start?.slice(0, 10) || 'earlier'} to ${globalSummary.coverage_end?.slice(0, 10) || 'recent'})
${globalSummary.summary_text}`);
    }

    // 3. Fetch Category Summaries
    let categoryQuery = `
      SELECT c.id, c.name, c.description, s.summary_text, s.coverage_start, s.coverage_end, s.updated_at
      FROM categories c
      JOIN archive_summaries s ON s.category_id = c.id
      WHERE c.is_deleted = 0 AND s.is_deleted = 0
    `;
    const params = [];
    if (categoryIds && categoryIds.length > 0) {
      categoryQuery += ` AND c.id IN (${categoryIds.map(() => '?').join(',')})`;
      params.push(...categoryIds);
    }
    categoryQuery += ` ORDER BY s.coverage_end DESC LIMIT 5`;

    const categorySummaries = db.prepare(categoryQuery).all(...params);
    for (const cat of categorySummaries) {
      contextSections.push(`### Category: ${cat.name} (Updated: ${cat.updated_at?.slice(0, 10) || 'recent'})
${cat.summary_text}`);
    }

    // 4. If query is specific or temporal, search relevant conversation turns via FTS5
    if (userQuery && userQuery.trim().length > 3) {
      // Clean query for FTS
      const cleanFtsQuery = userQuery
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 3 && !['what', 'when', 'where', 'have', 'that', 'this', 'with', 'from'].includes(w.toLowerCase()))
        .join(' OR ');

      if (cleanFtsQuery) {
        try {
          const matchingMessages = db.prepare(`
            SELECT m.content, m.role, m.timestamp, m.provider, m.model, c.title as conversation_title
            FROM messages_fts fts
            JOIN messages m ON fts.message_id = m.id
            JOIN conversations c ON m.conversation_id = c.id
            WHERE messages_fts MATCH ? AND m.is_deleted = 0
            ORDER BY m.timestamp DESC
            LIMIT 4
          `).all(cleanFtsQuery);

          if (matchingMessages.length > 0) {
            const excerpts = matchingMessages.map(m => 
              `- [${m.timestamp?.slice(0, 16) || 'Past'}] Thread "${m.conversation_title || 'Untitled'}" (${m.provider || 'AI'}): ${m.role === 'user' ? 'User asked' : 'AI advised'}: "${m.content.slice(0, 280)}..."`
            ).join('\n');

            contextSections.push(`### Relevant Past Conversation Milestones (Search Hits)
${excerpts}`);
          }
        } catch (_) {}
      }
    }

    if (contextSections.length === 0) {
      return null;
    }

    const assembled = `[PERSONAL ARCHIVE MEMORY]
The user has enabled access to their timestamped personal AI archive. Use this context to answer questions accurately regarding past conversations, timestamps, and prior recommendations:

${contextSections.join('\n\n')}

Guideline: If the user asks when something was discussed or what previous conclusions/recommendations were, cite the dates and findings from the archive records above.`;

    return assembled;
  }
}

module.exports = new ContextInjector();
