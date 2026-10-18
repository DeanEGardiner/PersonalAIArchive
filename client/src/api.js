// API helper service for Personal AI Archive backend

async function request(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let errMessage = res.statusText;
    try {
      const errJson = await res.json();
      if (errJson && errJson.error) errMessage = errJson.error;
    } catch (_) {
      try {
        const text = await res.text();
        if (text) errMessage = text;
      } catch (_) {}
    }
    throw new Error(errMessage || `Request failed with status ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Provider health & available models
  getHealth() {
    return request('/api/health');
  },

  // Settings
  getSettings() {
    return request('/api/settings');
  },

  updateSettings(settings) {
    return request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
  },

  // Conversations
  getConversations() {
    return request('/api/conversations');
  },

  getConversation(id) {
    return request(`/api/conversations/${id}`);
  },

  createConversation({ title, provider, model }) {
    return request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, provider, model })
    });
  },

  updateConversation(id, { title, provider, model }) {
    return request(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, provider, model })
    });
  },

  deleteConversation(id) {
    return request(`/api/conversations/${id}`, {
      method: 'DELETE'
    });
  },

  // Unified Post Submission with SSE Streaming (Merging Strategy)
  async streamPost({
    conversationId,
    content,
    mode = 'standard',
    attachment,
    provider,
    model,
    onInit,
    onChunk,
    onError,
    onDone,
    abortSignal
  }) {
    const targetUrl = conversationId
      ? `/api/conversations/${conversationId}/posts?stream=true`
      : '/api/posts?stream=true';

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        conversationId,
        content,
        mode,
        attachment,
        provider,
        model
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      let errText = response.statusText;
      try {
        const errJson = await response.json();
        if (errJson?.error) errText = errJson.error;
      } catch (_) {
        try { errText = await response.text(); } catch (_) {}
      }
      throw new Error(`Post error: ${errText || response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep partial line for next iteration

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (!dataStr) continue;
          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.type === 'init') {
              onInit?.(parsed);
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

  // Non-streaming post fallback
  createPost({ conversationId, content, mode = 'standard', attachment, provider, model }) {
    const targetUrl = conversationId ? `/api/conversations/${conversationId}/posts` : '/api/posts';
    return request(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, content, mode, attachment, provider, model })
    });
  },

  // Direct message insertion into a conversation
  addMessage({ conversationId, role = 'assistant', content, provider, model }) {
    return request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, content, provider, model })
    });
  },

  // Summarize a specific URL with AI
  summarizeURL({ url, model }) {
    return request('/api/summarize-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, model })
    });
  },

  // Archive & Search
  searchArchive(query) {
    return request(`/api/archive/search?q=${encodeURIComponent(query)}`);
  },

  getTimeline(limit = 100) {
    return request(`/api/archive/timeline?limit=${limit}`);
  },

  // Visualization / Mind Map
  getMindMap(query = '', maxNodes = 45) {
    const qStr = query ? `?q=${encodeURIComponent(query)}&maxNodes=${maxNodes}` : `?maxNodes=${maxNodes}`;
    return request(`/api/visualize/mindmap${qStr}`);
  },

  // Summaries & Search Digests
  getDigests(corpus = 'all') {
    const qs = corpus && corpus !== 'all' ? `?corpus=${encodeURIComponent(corpus)}` : '';
    return request(`/api/digests${qs}`);
  },

  getDigestsPreview(mode = 'incremental') {
    return request(`/api/digests/preview?mode=${encodeURIComponent(mode)}`);
  },

  generateDigests({ corpus = 'all', mode = 'incremental', overrideProvider, overrideModel, apiKey } = {}) {
    return request('/api/digests/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corpus, mode, overrideProvider, overrideModel, apiKey })
    });
  },

  getSummaries(corpus = 'all') {
    const qs = corpus && corpus !== 'all' ? `?corpus=${encodeURIComponent(corpus)}` : '';
    return request(`/api/summaries${qs}`);
  },

  getGlobalSummary() {
    return request('/api/summaries/global');
  },

  getCategories() {
    return request('/api/categories');
  },

  generateSummaries({ corpus = 'all', mode = 'incremental', overrideProvider, overrideModel, apiKey } = {}) {
    return request('/api/summaries/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ corpus, mode, overrideProvider, overrideModel, apiKey })
    });
  },

  // Image Upload helper
  uploadImage(formData) {
    return request('/api/upload', {
      method: 'POST',
      body: formData
    });
  },

  // Obsidian Vault Integration
  getObsidianStatus() {
    return request('/api/obsidian/status');
  },

  updateObsidianVaultPath(vaultPath) {
    return request('/api/obsidian/vault-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultPath })
    });
  },

  syncObsidian(vaultPath) {
    return request('/api/obsidian/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultPath })
    });
  },

  getObsidianNotes(query = '', limit = 100) {
    return request(`/api/obsidian/notes?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  getObsidianNoteById(id) {
    return request(`/api/obsidian/notes/${id}`);
  },

  // Database Backup & Restore
  previewBackup(formDataOrData) {
    if (formDataOrData instanceof FormData) {
      return request('/api/restore/preview', {
        method: 'POST',
        body: formDataOrData
      });
    }
    return request('/api/restore/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formDataOrData)
    });
  },

  restoreBackup(formDataOrData) {
    if (formDataOrData instanceof FormData) {
      return request('/api/restore/json', {
        method: 'POST',
        body: formDataOrData
      });
    }
    return request('/api/restore/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formDataOrData)
    });
  },

  // Local Hybrid Search & Embeddings
  getEmbeddingStatus() {
    return request('/api/embeddings/status');
  },

  triggerEmbeddingBackfill(batchSize = 100) {
    return request('/api/embeddings/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchSize })
    });
  }
};
