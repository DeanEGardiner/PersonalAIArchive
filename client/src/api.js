// API helper service for Personal AI Archive backend

export const api = {
  // Provider health & available models
  async getHealth() {
    const res = await fetch('/api/health');
    if (!res.ok) throw new Error('Failed to fetch provider health');
    return res.json();
  },

  // Settings
  async getSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  },

  async updateSettings(settings) {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!res.ok) throw new Error('Failed to update settings');
    return res.json();
  },

  // Conversations
  async getConversations() {
    const res = await fetch('/api/conversations');
    if (!res.ok) throw new Error('Failed to fetch conversations');
    return res.json();
  },

  async getConversation(id) {
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) throw new Error('Failed to fetch conversation');
    return res.json();
  },

  async createConversation({ title, provider, model }) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, provider, model })
    });
    if (!res.ok) throw new Error('Failed to create conversation');
    return res.json();
  },

  async deleteConversation(id) {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('Failed to delete conversation');
    return res.json();
  },

  // Streaming Chat via SSE reader
  async streamChat({
    conversationId,
    message,
    provider,
    model,
    onChunk,
    onError,
    onDone,
    abortSignal
  }) {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        message,
        provider,
        model
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Chat error: ${errText || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr) continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'init') {
              // initialized
            } else if (parsed.type === 'chunk') {
              onChunk?.(parsed.text);
            } else if (parsed.type === 'error') {
              onError?.(parsed.error);
            } else if (parsed.type === 'done') {
              onDone?.(parsed);
            }
          } catch (e) {
            console.error('SSE parse error:', e, dataStr);
          }
        }
      }
    }
  },

  // Archive & Search
  async searchArchive(query) {
    const res = await fetch(`/api/archive/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Failed to search archive');
    return res.json();
  },

  async getTimeline(limit = 100) {
    const res = await fetch(`/api/archive/timeline?limit=${limit}`);
    if (!res.ok) throw new Error('Failed to load timeline');
    return res.json();
  },

  // Summaries & Categories
  async getSummaries() {
    const res = await fetch('/api/summaries');
    if (!res.ok) throw new Error('Failed to fetch summaries');
    return res.json();
  },

  async getGlobalSummary() {
    const res = await fetch('/api/summaries/global');
    if (!res.ok) throw new Error('Failed to fetch global summary');
    return res.json();
  },

  async getCategories() {
    const res = await fetch('/api/categories');
    if (!res.ok) throw new Error('Failed to fetch categories');
    return res.json();
  },

  async generateSummaries({ mode = 'incremental', overrideProvider, overrideModel, apiKey } = {}) {
    const res = await fetch('/api/summaries/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, overrideProvider, overrideModel, apiKey })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to generate summaries');
    }
    return res.json();
  },

  // Google Search AI Grounding
  async searchGoogleAI({ query, model = 'gemini-3.6-flash' }) {
    const res = await fetch('/api/search/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, model })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to search Google AI');
    }
    return res.json();
  },

  // Direct message insertion into a conversation
  async addMessage({ conversationId, role = 'assistant', content, provider = 'gemini', model = 'gemini-3.6-flash' }) {
    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, provider, model })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to add message');
    }
    return res.json();
  },

  // Summarize a specific URL with AI
  async summarizeURL({ url, model = 'gemini-3.6-flash' }) {
    const res = await fetch('/api/summarize-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, model })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to summarize web page');
    }
    return res.json();
  },

  // Triple-Action Post Submission ('standard', 'ai_analysis', 'google_search')
  async createPost({ conversationId, content, mode = 'standard', attachment, provider = 'gemini', model = 'gemini-3.8-flash' }) {
    const targetUrl = conversationId ? `/api/conversations/${conversationId}/posts` : '/api/posts';
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, content, mode, attachment, provider, model })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to submit post');
    }
    return res.json();
  },

  // Image Upload helper
  async uploadImage(formData) {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to upload image');
    }
    return res.json();
  },

  // Obsidian Vault Integration
  async getObsidianStatus() {
    const res = await fetch('/api/obsidian/status');
    if (!res.ok) throw new Error('Failed to fetch Obsidian vault status');
    return res.json();
  },

  async updateObsidianVaultPath(vaultPath) {
    const res = await fetch('/api/obsidian/vault-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultPath })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to update Obsidian vault path');
    }
    return res.json();
  },

  async syncObsidian(vaultPath) {
    const res = await fetch('/api/obsidian/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultPath })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to sync Obsidian vault');
    }
    return res.json();
  },

  async getObsidianNotes(query = '', limit = 100) {
    const res = await fetch(`/api/obsidian/notes?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) throw new Error('Failed to fetch Obsidian notes');
    return res.json();
  },

  async getObsidianNoteById(id) {
    const res = await fetch(`/api/obsidian/notes/${id}`);
    if (!res.ok) throw new Error('Failed to fetch note');
    return res.json();
  }
};

