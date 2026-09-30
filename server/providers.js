const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

class ProviderRouter {
  constructor() {
    this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.lmStudioBaseUrl = process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';
  }

  getLMStudioBaseUrl() {
    let url = this.lmStudioBaseUrl || 'http://localhost:1234/v1';
    url = url.trim().replace(/\/+$/, '');
    if (!url.endsWith('/v1')) {
      url += '/v1';
    }
    return url;
  }

  getOpenAIClient(apiKey) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OpenAI API Key is missing. Please set it in Settings or .env');
    return new OpenAI({ apiKey: key });
  }

  getGeminiClient(apiKey) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Gemini API Key is missing. Please set it in Settings or .env');
    return new GoogleGenAI({ apiKey: key });
  }

  async checkHealth() {
    const { db } = require('./db');
    const ollamaSetting = db.prepare("SELECT value FROM settings WHERE key = 'ollama_base_url'").get();
    const lmStudioSetting = db.prepare("SELECT value FROM settings WHERE key = 'lmstudio_base_url'").get();
    const geminiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
    const openAiKeySetting = db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get();

    if (ollamaSetting?.value) this.ollamaBaseUrl = ollamaSetting.value;
    if (lmStudioSetting?.value) this.lmStudioBaseUrl = lmStudioSetting.value;

    const geminiKey = geminiKeySetting?.value || process.env.GEMINI_API_KEY;
    const openAiKey = openAiKeySetting?.value || process.env.OPENAI_API_KEY;

    const defaultGeminiModels = [
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-2.5-pro'
    ];

    const defaultOpenAIModels = [
      'gpt-4o-mini',
      'gpt-4o',
      'o3-mini',
      'gpt-4-turbo'
    ];

    const status = {
      gemini: { 
        available: !!geminiKey, 
        name: 'Google Gemini', 
        models: defaultGeminiModels 
      },
      openai: { 
        available: !!openAiKey, 
        name: 'OpenAI ChatGPT', 
        models: defaultOpenAIModels 
      },
      ollama: { available: false, name: 'Ollama (Local :11434)', models: [] },
      lmstudio: { available: false, name: 'LM Studio (Local :1234)', models: [] }
    };

    // If Gemini key is available, query real supported text models dynamically
    if (geminiKey) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`, {
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok) {
          const data = await res.json();
          const cleanModels = (data.models || [])
            .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => m.name.replace('models/', ''))
            .filter(m => m.startsWith('gemini-') && !m.includes('tts') && !m.includes('image') && !m.includes('preview'));
          if (cleanModels.length > 0) {
            status.gemini.models = cleanModels;
          }
        }
      } catch (_) {}
    }

    // Probe Ollama
    try {
      const res = await fetch(`${this.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        status.ollama.available = true;
        status.ollama.models = (data.models || []).map(m => m.name);
      }
    } catch (_) {}

    // Probe LM Studio
    try {
      const lmBase = this.getLMStudioBaseUrl();
      const res = await fetch(`${lmBase}/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        status.lmstudio.available = true;
        status.lmstudio.models = (data.data || []).map(m => m.id);
      }
    } catch (_) {}

    return status;
  }

  async streamChat({ provider, model, messages, systemPrompt, apiKey, abortSignal, onChunk, jsonMode = false }) {
    const { db } = require('./db');
    const ollamaSetting = db.prepare("SELECT value FROM settings WHERE key = 'ollama_base_url'").get();
    const lmStudioSetting = db.prepare("SELECT value FROM settings WHERE key = 'lmstudio_base_url'").get();
    if (ollamaSetting?.value) this.ollamaBaseUrl = ollamaSetting.value;
    if (lmStudioSetting?.value) this.lmStudioBaseUrl = lmStudioSetting.value;

    if (provider === 'gemini') {
      return this.streamGemini({ model: model || 'gemini-3.6-flash', messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode });
    } else if (provider === 'openai') {
      return this.streamOpenAI({ model: model || 'gpt-4o-mini', messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode });
    } else if (provider === 'ollama') {
      return this.streamOllama({ model: model || 'gemma4:12b-mlx', messages, systemPrompt, onChunk, abortSignal, jsonMode });
    } else if (provider === 'lmstudio') {
      return this.streamLMStudio({ model: model || 'qwen/qwen3.8-27b', messages, systemPrompt, onChunk, abortSignal, jsonMode });
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async streamGemini({ model, messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode }) {
    const ai = this.getGeminiClient(apiKey);
    
    // Format conversation for Gemini
    const contents = [];
    for (const m of messages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }

    const config = {};
    if (systemPrompt) {
      config.systemInstruction = systemPrompt;
    }
    if (jsonMode) {
      config.responseMimeType = 'application/json';
    }

    const responseStream = await ai.models.generateContentStream({
      model,
      contents,
      config
    });

    let fullText = '';
    for await (const chunk of responseStream) {
      if (abortSignal && abortSignal.aborted) break;
      const text = chunk.text || '';
      fullText += text;
      onChunk(text);
    }
    return fullText;
  }

  async streamOpenAI({ model, messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode }) {
    const openai = this.getOpenAIClient(apiKey);
    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const stream = await openai.chat.completions.create({
      model,
      messages: apiMessages,
      stream: true,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    }, { signal: abortSignal });

    let fullText = '';
    for await (const chunk of stream) {
      if (abortSignal && abortSignal.aborted) break;
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullText += text;
        onChunk(text);
      }
    }
    return fullText;
  }

  async streamOllama({ model, messages, systemPrompt, onChunk, abortSignal, jsonMode }) {
    console.log(`[Ollama Provider] Connecting to ${this.ollamaBaseUrl}/api/chat with model '${model}' (jsonMode=${!!jsonMode})...`);
    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const t0 = Date.now();
    let res;
    try {
      const payload = {
        model,
        messages: apiMessages,
        stream: true
      };
      if (jsonMode) {
        payload.format = 'json';
      }
      res = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortSignal
      });
    } catch (fetchErr) {
      console.error(`[Ollama Provider] Fetch failed: ${fetchErr.message}`);
      throw fetchErr;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      console.error(`[Ollama Provider] HTTP ${res.status}: ${errText}`);
      throw new Error(`Ollama error (${res.status}): ${errText || res.statusText}`);
    }

    console.log(`[Ollama Provider] Connected successfully in ${Date.now() - t0}ms. Reading stream...`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let tokens = 0;

    while (true) {
      if (abortSignal && abortSignal.aborted) {
        console.log(`[Ollama Provider] Abort signal triggered, exiting read loop.`);
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          const text = json.message?.content || '';
          if (text) {
            tokens++;
            fullText += text;
            onChunk(text);
          }
          if (json.done) {
            console.log(`[Ollama Provider] Stream done. Prompt tokens evaluated: ${json.prompt_eval_count || 'N/A'}, response tokens: ${tokens}, total duration: ${((Date.now() - t0)/1000).toFixed(2)}s`);
          }
        } catch (_) {}
      }
    }
    return fullText;
  }

  async streamLMStudio({ model, messages, systemPrompt, onChunk, abortSignal, jsonMode }) {
    const lmUrl = this.getLMStudioBaseUrl();
    console.log(`[LM Studio Provider] Connecting to ${lmUrl} with model '${model}' (jsonMode=${!!jsonMode})...`);
    const openai = new OpenAI({
      baseURL: lmUrl,
      apiKey: 'lm-studio'
    });

    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const t0 = Date.now();
    const stream = await openai.chat.completions.create({
      model,
      messages: apiMessages,
      stream: true,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    }, { signal: abortSignal });

    console.log(`[LM Studio Provider] Stream connection opened in ${Date.now() - t0}ms. Reading chunks...`);
    let fullText = '';
    let reasoningText = '';
    let tokens = 0;
    for await (const chunk of stream) {
      if (abortSignal && abortSignal.aborted) {
        console.log(`[LM Studio Provider] Abort signal triggered.`);
        break;
      }
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content || '';
      const reasoning = delta?.reasoning_content || delta?.reasoning || '';
      if (reasoning) {
        reasoningText += reasoning;
      }
      if (text) {
        tokens++;
        fullText += text;
        onChunk(text);
      }
    }

    // Fallback if model only outputted reasoning_content
    if (!fullText.trim() && reasoningText.trim()) {
      console.log(`[LM Studio Provider] Model only emitted reasoning (${reasoningText.length} chars), yielding reasoning as output.`);
      onChunk(reasoningText);
      fullText = reasoningText;
    }

    console.log(`[LM Studio Provider] Stream done. Generated ${tokens} content chunks (${reasoningText.length} reasoning chars), total duration: ${((Date.now() - t0)/1000).toFixed(2)}s`);
    return fullText;
  }

  async googleSearchAI({ query, model = 'gemini-3.6-flash', apiKey }) {
    const ai = this.getGeminiClient(apiKey);
    console.log(`[Google Search AI] Executing search grounding query: "${query}" using model ${model}...`);

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: query }]
        }
      ],
      config: {
        tools: [{ googleSearch: {} }]
      }
    });

    const candidate = response.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata || {};
    
    // Extract search queries used by Google
    const searchQueries = groundingMetadata.webSearchQueries || [];

    // Extract sources/citations
    const sources = [];
    if (Array.isArray(groundingMetadata.groundingChunks)) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push({
            title: chunk.web.title || new URL(chunk.web.uri).hostname,
            url: chunk.web.uri
          });
        }
      }
    }

    return {
      text: response.text || '',
      searchQueries,
      sources,
      model
    };
  }

  async summarizeURL({ url, model = 'gemini-3.6-flash', apiKey }) {
    let pageContent = '';
    let pageTitle = '';
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (resp.ok) {
        const html = await resp.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) pageTitle = titleMatch[1].trim();

        // Strip scripts, styles, nav, footer, headers and tags
        let cleaned = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
          .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
          .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
          .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        pageContent = cleaned.slice(0, 15000);
      }
    } catch (fetchErr) {
      console.warn(`[URL Summarizer] Direct fetch of ${url} failed or timed out (${fetchErr.message}). Falling back to Google Grounding...`);
    }

    const ai = this.getGeminiClient(apiKey);
    let prompt;
    let config = {};

    if (pageContent && pageContent.length > 150) {
      prompt = `Please provide a clear, comprehensive, and well-structured summary of the web page at: ${url}
${pageTitle ? `Page Title: "${pageTitle}"\n` : ''}
Extracted Content:
"""
${pageContent}
"""

Format your response nicely with:
- A brief 1-2 sentence core overview
- Key highlights or takeaways in bullet points
- Why this matters / conclusions (if applicable)
Include a reference link back to ${url}`;
    } else {
      // Fallback: Use Gemini Google Search grounding to retrieve and synthesize info about the specific URL
      prompt = `Please provide a thorough, accurate summary and key takeaways of the web page and topic at: ${url}. If you have information about this exact page, synthesize its key points and takeaways clearly. Include the link [${url}](${url}).`;
      config = {
        tools: [{ googleSearch: {} }]
      };
    }

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      config
    });

    return {
      summary: response.text || 'Unable to generate summary for this link.',
      url,
      title: pageTitle || url
    };
  }
}

module.exports = new ProviderRouter();
