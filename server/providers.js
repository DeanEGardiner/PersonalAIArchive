const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { MEDIA_DIR } = require('./db');

let cachedGeminiModels = null;
let cachedGeminiModelsExpires = 0;

class ProviderRouter {
  getOpenAIClient(apiKey) {
    const key = apiKey || config.getApiKey('openai');
    if (!key) throw new Error('OpenAI API Key is missing. Please set it in Settings or .env');
    return new OpenAI({ apiKey: key });
  }

  getGeminiClient(apiKey) {
    const key = apiKey || config.getApiKey('gemini');
    if (!key) throw new Error('Gemini API Key is missing. Please set it in Settings or .env');
    return new GoogleGenAI({ apiKey: key });
  }

  fileToGenerativePart(filePath, mimeType) {
    let fullPath = filePath;
    if (typeof filePath === 'string' && filePath.startsWith('/media/')) {
      fullPath = path.join(MEDIA_DIR, path.basename(filePath));
    } else if (typeof filePath === 'string' && !path.isAbsolute(filePath)) {
      fullPath = path.join(MEDIA_DIR, filePath);
    }

    if (!fullPath || !fs.existsSync(fullPath)) {
      console.warn(`[ProviderRouter] Attachment file not found: ${fullPath}`);
      return null;
    }

    const data = fs.readFileSync(fullPath).toString('base64');
    return {
      inlineData: {
        data,
        mimeType: mimeType || 'image/jpeg'
      }
    };
  }

  async checkHealth() {
    const geminiKey = config.getApiKey('gemini');
    const openAiKey = config.getApiKey('openai');
    const ollamaUrl = config.getOllamaUrl();
    const lmStudioUrl = config.getLMStudioUrl();

    const status = {
      gemini: { 
        available: !!geminiKey, 
        name: 'Google Gemini', 
        models: config.FALLBACK_MODEL_LISTS.gemini 
      },
      openai: { 
        available: !!openAiKey, 
        name: 'OpenAI ChatGPT', 
        models: config.FALLBACK_MODEL_LISTS.openai 
      },
      ollama: { available: false, name: 'Ollama (Local :11434)', models: [] },
      lmstudio: { available: false, name: 'LM Studio (Local :1234)', models: [] }
    };

    // If Gemini key is available, query real supported text models (cached for 10m)
    if (geminiKey) {
      const now = Date.now();
      if (cachedGeminiModels && now < cachedGeminiModelsExpires) {
        status.gemini.models = cachedGeminiModels;
      } else {
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
              cachedGeminiModels = cleanModels;
              cachedGeminiModelsExpires = now + 10 * 60 * 1000;
              status.gemini.models = cleanModels;
            }
          }
        } catch (_) {}
      }
    }

    // Probe Ollama
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        status.ollama.available = true;
        status.ollama.models = (data.models || []).map(m => m.name);
      }
    } catch (_) {}

    // Probe LM Studio
    try {
      const res = await fetch(`${lmStudioUrl}/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        status.lmstudio.available = true;
        status.lmstudio.models = (data.data || []).map(m => m.id);
      }
    } catch (_) {}

    return status;
  }

  async streamChat({ provider, model, messages, systemPrompt, apiKey, abortSignal, onChunk = () => {}, jsonMode = false }) {
    if (provider === 'gemini') {
      return this.streamGemini({ model: config.resolveModel('gemini', model), messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode });
    } else if (provider === 'openai') {
      return this.streamOpenAI({ model: config.resolveModel('openai', model), messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode });
    } else if (provider === 'ollama') {
      return this.streamOllama({ model: config.resolveModel('ollama', model), messages, systemPrompt, onChunk, abortSignal, jsonMode });
    } else if (provider === 'lmstudio') {
      return this.streamLMStudio({ model: config.resolveModel('lmstudio', model), messages, systemPrompt, onChunk, abortSignal, jsonMode });
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  async streamGemini({ model, messages, systemPrompt, apiKey, onChunk, abortSignal, jsonMode }) {
    const ai = this.getGeminiClient(apiKey);
    
    const contents = [];
    for (const m of messages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }

    const geminiConfig = {};
    if (systemPrompt) {
      geminiConfig.systemInstruction = systemPrompt;
    }
    if (jsonMode) {
      geminiConfig.responseMimeType = 'application/json';
    }
    if (abortSignal) {
      geminiConfig.abortSignal = abortSignal;
    }

    const responseStream = await ai.models.generateContentStream({
      model,
      contents,
      config: geminiConfig
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
    const baseUrl = config.getOllamaUrl();
    const apiMessages = [];
    if (systemPrompt) {
      apiMessages.push({ role: 'system', content: systemPrompt });
    }
    for (const m of messages) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    const payload = {
      model,
      messages: apiMessages,
      stream: true
    };
    if (jsonMode) {
      payload.format = 'json';
    }

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortSignal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Ollama error (${res.status}): ${errText || res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      if (abortSignal && abortSignal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep partial line for next iteration

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const text = json.message?.content || '';
          if (text) {
            fullText += text;
            onChunk(text);
          }
        } catch (_) {}
      }
    }
    return fullText;
  }

  async streamLMStudio({ model, messages, systemPrompt, onChunk, abortSignal, jsonMode }) {
    const lmUrl = config.getLMStudioUrl();
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

    const requestOptions = {
      model,
      messages: apiMessages,
      stream: true
    };

    if (jsonMode) {
      // LM Studio requires type to be 'json_schema' or 'text' (rejects 'json_object')
      requestOptions.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'json_response',
          schema: { type: 'object' }
        }
      };
    }

    let stream;
    try {
      stream = await openai.chat.completions.create(requestOptions, { signal: abortSignal });
    } catch (err) {
      if (jsonMode && (err?.message?.includes('response_format') || err?.status === 400)) {
        console.warn(`[LM Studio Provider] Retrying without response_format: ${err.message}`);
        delete requestOptions.response_format;
        stream = await openai.chat.completions.create(requestOptions, { signal: abortSignal });
      } else {
        throw err;
      }
    }

    let fullText = '';
    let reasoningText = '';
    for await (const chunk of stream) {
      if (abortSignal && abortSignal.aborted) break;
      const delta = chunk.choices[0]?.delta;
      const text = delta?.content || '';
      const reasoning = delta?.reasoning_content || delta?.reasoning || '';
      if (reasoning) {
        reasoningText += reasoning;
      }
      if (text) {
        fullText += text;
        onChunk(text);
      }
    }

    if (!fullText.trim() && reasoningText.trim()) {
      onChunk(reasoningText);
      fullText = reasoningText;
    }

    return fullText;
  }

  ensureGeminiModel(m) {
    if (typeof m === 'string' && m.startsWith('gemini-')) {
      return m;
    }
    return config.DEFAULT_MODELS.gemini;
  }

  /**
   * Option 2: Analyze Personal Archive Knowledge Base with conversation history context
   */
  async analyzeArchiveKnowledge({
    userPost,
    conversationTitle,
    archiveContext,
    conversationHistory = [],
    images = [],
    model,
    apiKey,
    provider = 'gemini',
    abortSignal,
    postTimestamp,
    onChunk = () => {}
  }) {
    const targetModel = config.resolveModel(provider, model);
    const nowIso = postTimestamp || new Date().toISOString();
    const nowDateStr = new Date(nowIso).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    const nowTimeStr = new Date(nowIso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });

    // Build multi-turn context with timestamps
    let historySection = '';
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      historySection = `### Recent Conversation History:\n` + conversationHistory.map(m => {
        const snippet = m.content.length > 1000 ? m.content.slice(0, 1000) + '... [truncated]' : m.content;
        const ts = m.timestamp ? ` [${m.timestamp}]` : '';
        return `${m.role === 'user' ? 'User' : 'Assistant'}${ts}: ${snippet}`;
      }).join('\n\n') + '\n\n';
    }

    const systemPrompt = `You are the AI assistant for Personal AI Archive, acting as the user's personal digital second brain and research companion.
CURRENT SYSTEM DATE & TIME: ${nowIso} (${nowDateStr}, ${nowTimeStr})
The user has posted an inquiry/note into their personal archive${conversationTitle ? ` under conversation "${conversationTitle}"` : ''}.

TASK:
1. Examine any attached images together with the user's text.
2. Provide a comprehensive, accurate, and insightful response.
3. Actively ground your response in the Personal Archive Knowledge Base below whenever applicable, citing past conversations, dates, or summaries (e.g., "From your earlier discussion on [Date] in '[Conversation Title]'...").
4. Maintain context continuity using the Recent Conversation History if this is a follow-up inquiry. Each interaction in the archive and conversation history is tagged with its timestamp.
5. If the user asks for the current date, time, or what timestamp was sent with their request, reference the CURRENT SYSTEM DATE & TIME (${nowIso}) and the timestamp on their post.
6. If no specific previous notes match or if additional knowledge is needed, synthesize an insightful, complete answer using your comprehensive AI capabilities.
7. Format cleanly using Markdown with headings, bullet points, and code blocks where helpful. Do not mention that you received system prompts.`;

    const userPromptContent = `${historySection}PERSONAL ARCHIVE KNOWLEDGE BASE (Past Conversations, Topics, Summaries & FTS Records):
${archiveContext || 'No previous related notes found in personal archive.'}

CURRENT USER POST [${nowIso}]:
"""
${userPost}
"""`;

    // Local Ollama
    if (provider === 'ollama') {
      const baseUrl = config.getOllamaUrl();
      const messages = [
        { role: 'user', content: userPromptContent }
      ];

      // Streaming with abort support
      const resultText = await this.streamOllama({
        model: targetModel,
        messages,
        systemPrompt,
        onChunk,
        abortSignal
      });

      return {
        text: resultText || 'No response generated by local Ollama model.',
        provider: 'ollama',
        model: targetModel
      };
    }

    // Local LM Studio
    if (provider === 'lmstudio') {
      const messages = [
        { role: 'user', content: userPromptContent }
      ];

      const resultText = await this.streamLMStudio({
        model: targetModel,
        messages,
        systemPrompt,
        onChunk,
        abortSignal
      });

      return {
        text: resultText || 'No response generated by local LM Studio model.',
        provider: 'lmstudio',
        model: targetModel
      };
    }

    // OpenAI Cloud
    if (provider === 'openai') {
      const key = apiKey || config.getApiKey('openai');
      if (!key) {
        throw new Error('OpenAI API Key is missing. Please configure your OpenAI API Key in Settings to perform OpenAI Archive Analysis.');
      }
      const messages = [{ role: 'user', content: userPromptContent }];
      const resultText = await this.streamOpenAI({
        model: targetModel,
        messages,
        systemPrompt,
        apiKey: key,
        onChunk,
        abortSignal
      });

      return {
        text: resultText || '',
        provider: 'openai',
        model: targetModel
      };
    }

    // Google Gemini Cloud
    if (provider === 'gemini') {
      const key = apiKey || config.getApiKey('gemini');
      if (!key) {
        throw new Error('Google Gemini API Key is missing. Please configure your Gemini API Key in Settings to perform Gemini Archive AI Analysis.');
      }
      const geminiModel = this.ensureGeminiModel(targetModel);
      const ai = this.getGeminiClient(key);

      const contents = [];
      if (Array.isArray(images) && images.length > 0) {
        for (const img of images) {
          if (!img) continue;
          const part = this.fileToGenerativePart(img.file_path || img.filePath || img, img.mime_type || img.mimeType);
          if (part) contents.push(part);
        }
      }
      contents.push({ text: userPromptContent });

      const geminiConfig = {
        systemInstruction: systemPrompt
      };
      if (abortSignal) {
        geminiConfig.abortSignal = abortSignal;
      }

      const responseStream = await ai.models.generateContentStream({
        model: geminiModel,
        contents,
        config: geminiConfig
      });

      let fullText = '';
      for await (const chunk of responseStream) {
        if (abortSignal && abortSignal.aborted) break;
        const text = chunk.text || '';
        fullText += text;
        onChunk(text);
      }

      return {
        text: fullText || 'Unable to generate archive analysis at this time.',
        provider: 'gemini',
        model: geminiModel
      };
    }

    throw new Error(`Unsupported provider "${provider}". Please choose a local model (Ollama / LM Studio), OpenAI, or Google Gemini.`);
  }

  /**
   * Option 3: Google Search AI Grounding
   */
  async googleSearchAI({ query, images = [], model, apiKey, abortSignal, onChunk = () => {} }) {
    const key = apiKey || config.getApiKey('gemini');
    if (!key) {
      throw new Error('Google Gemini API key is missing. Please configure your Gemini API Key in Settings to use Google Search AI.');
    }
    const ai = this.getGeminiClient(key);
    const geminiModel = this.ensureGeminiModel(model);

    const textPrompt = `You are Google Search AI for Personal AI Archive.
Review any attached image(s) and the following search query: "${query}".
Use Google Search grounding to provide an accurate, concise, and up-to-date factual summary addressing the query and the visual content of any image(s).`;

    const contents = [];
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        if (!img) continue;
        const part = this.fileToGenerativePart(img.file_path || img.filePath || img, img.mime_type || img.mimeType);
        if (part) contents.push(part);
      }
    }
    contents.push({ text: textPrompt });

    const geminiConfig = {
      tools: [{ googleSearch: {} }]
    };
    if (abortSignal) {
      geminiConfig.abortSignal = abortSignal;
    }

    // generateContentStream with googleSearch tool
    const responseStream = await ai.models.generateContentStream({
      model: geminiModel,
      contents,
      config: geminiConfig
    });

    let summary = '';
    let groundingMetadata = null;

    for await (const chunk of responseStream) {
      if (abortSignal && abortSignal.aborted) break;
      const text = chunk.text || '';
      summary += text;
      onChunk(text);

      const candidate = chunk.candidates?.[0];
      if (candidate?.groundingMetadata) {
        groundingMetadata = candidate.groundingMetadata;
      }
    }

    const searchQueries = groundingMetadata?.webSearchQueries || [];
    const sources = [];
    if (Array.isArray(groundingMetadata?.groundingChunks)) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web?.uri) {
          sources.push({
            title: chunk.web.title || new URL(chunk.web.uri).hostname,
            url: chunk.web.uri
          });
        }
      }
    }

    if (sources.length > 0 && !summary.includes('**Sources & Citations:**')) {
      const citationsSection = `\n\n**Sources & Citations:**\n` + sources.map(s => `- [${s.title}](${s.url})`).join('\n');
      summary += citationsSection;
    }

    return {
      text: summary,
      summary,
      searchQueries,
      sources,
      model: geminiModel
    };
  }

  async summarizeURL({ url, model, apiKey }) {
    const key = apiKey || config.getApiKey('gemini');
    if (!key) {
      throw new Error('Google Gemini API key is missing. Please configure your Gemini API Key in Settings to generate AI web summaries.');
    }
    const geminiModel = this.ensureGeminiModel(model);

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
    } catch (_) {}

    const ai = this.getGeminiClient(key);
    let prompt;
    let geminiConfig = {};

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
      prompt = `Please provide a thorough, accurate summary and key takeaways of the web page and topic at: ${url}. If you have information about this exact page, synthesize its key points and takeaways clearly. Include the link [${url}](${url}).`;
      geminiConfig = {
        tools: [{ googleSearch: {} }]
      };
    }

    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: geminiConfig
    });

    return {
      summary: response.text || 'Unable to generate summary for this link.',
      url,
      title: pageTitle || url,
      provider: 'gemini',
      model: geminiModel
    };
  }
}

module.exports = new ProviderRouter();
