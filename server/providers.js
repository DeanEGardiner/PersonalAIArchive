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

  fileToGenerativePart(filePath, mimeType) {
    const fs = require('fs');
    const path = require('path');
    const { MEDIA_DIR } = require('./db');

    let fullPath = filePath;
    if (typeof filePath === 'string' && filePath.startsWith('/media/')) {
      fullPath = path.join(MEDIA_DIR, path.basename(filePath));
    } else if (typeof filePath === 'string' && !path.isAbsolute(filePath)) {
      fullPath = path.join(MEDIA_DIR, filePath);
    }

    if (!fs.existsSync(fullPath)) {
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

  ensureGeminiModel(m) {
    if (typeof m === 'string' && m.startsWith('gemini-')) {
      return m;
    }
    return 'gemini-3.8-flash';
  }

  /**
   * Option 2: Analyze Personal Archive Knowledge Base with Gemini (or fallback provider)
   */
  async analyzeArchiveKnowledge({ userPost, conversationTitle, archiveContext, images = [], model = 'gemini-3.8-flash', apiKey, provider = 'gemini' }) {
    const textPrompt = `You are the AI assistant for Personal AI Archive, acting as the user's personal digital second brain and research companion.
The user has posted an inquiry/note into their personal archive${conversationTitle ? ` under conversation "${conversationTitle}"` : ''}.

USER POST:
"""
${userPost}
"""

PERSONAL ARCHIVE KNOWLEDGE BASE (Past Conversations, Topics, Summaries & FTS Records):
${archiveContext || 'No previous related notes found in personal archive.'}

TASK:
1. Examine any attached images together with the user's text.
2. Provide a comprehensive, accurate, and insightful response.
3. Actively ground your response in the user's Personal Archive Knowledge Base above whenever applicable, citing past conversations, dates, or summaries (e.g., "From your earlier discussion in '[Conversation Title]'...").
4. If no specific previous notes match or if additional knowledge is needed, synthesize an insightful, complete answer using your comprehensive AI capabilities.
5. Format cleanly using Markdown with headings, bullet points, and code blocks where helpful. Do not mention that you received system prompts.`;

    // Multimodal contents
    const contents = [];
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        if (!img) continue;
        const part = this.fileToGenerativePart(img.file_path || img.filePath || img, img.mime_type || img.mimeType);
        if (part) contents.push(part);
      }
    }
    contents.push({ text: textPrompt });

    // 1. STRICT LOCAL OLLAMA ROUTING (Never fall back to cloud)
    if (provider === 'ollama') {
      const { db } = require('./db');
      const ollamaSetting = db.prepare("SELECT value FROM settings WHERE key = 'ollama_base_url'").get();
      const baseUrl = ollamaSetting?.value || this.ollamaBaseUrl || 'http://localhost:11434';
      const targetModel = model || 'gemma4:12b-mlx';

      try {
        const ollamaImages = [];
        if (Array.isArray(images) && images.length > 0) {
          for (const img of images) {
            const part = this.fileToGenerativePart(img.file_path || img.filePath || img, img.mime_type || img.mimeType);
            if (part?.inlineData?.data) {
              ollamaImages.push(part.inlineData.data);
            }
          }
        }

        const systemPrompt = `You are the Personal AI Archive assistant, acting as the user's private digital second brain.
Analyze the user's inquiry against the provided Personal Archive Knowledge Base.
Ground your response directly in any matching past conversations or archive summaries (cite them clearly by conversation title).
If the archive does not contain the requested information, state that clearly and provide a concise, helpful response.
Be direct, factual, and concise.`;

        const userPromptContent = `USER INQUIRY:
"""
${userPost}
"""

PERSONAL ARCHIVE KNOWLEDGE BASE:
${archiveContext || 'No previous related records found in personal archive.'}`;

        const bodyPayload = {
          model: targetModel,
          prompt: `${systemPrompt}\n\n${userPromptContent}`,
          stream: false,
          options: {
            num_predict: 1500,
            temperature: 0.3
          }
        };
        if (ollamaImages.length > 0) {
          bodyPayload.images = ollamaImages;
        }

        const resp = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
          signal: AbortSignal.timeout(180000) // 3-minute timeout for local model generation
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`Ollama returned status ${resp.status}: ${errText}`);
        }
        const data = await resp.json();
        return {
          text: data.response || 'No response generated by local Ollama model.',
          provider: 'ollama',
          model: targetModel
        };
      } catch (ollamaErr) {
        console.error(`[ProviderRouter] Ollama local model (${targetModel}) error:`, ollamaErr.message);
        if (ollamaErr.name === 'TimeoutError' || ollamaErr.message.includes('timeout') || ollamaErr.name === 'AbortError') {
          throw new Error(`The local Ollama model "${targetModel}" timed out while analyzing the archive (took longer than 3 minutes). The server is running, but generating the answer took too long.`);
        }
        throw new Error(`The local Ollama model "${targetModel}" is not available at ${baseUrl}. Please ensure Ollama is running and "${targetModel}" is loaded. To protect your data privacy, local archive analysis will never fall back to cloud AI or Google search.`);
      }
    }

    // 2. STRICT LOCAL LM STUDIO ROUTING (Never fall back to cloud)
    if (provider === 'lmstudio') {
      const baseUrl = this.getLMStudioBaseUrl();
      const targetModel = model || 'local-model';

      try {
        const systemPrompt = `You are the Personal AI Archive assistant, acting as the user's private digital second brain.
Analyze the user's inquiry against the provided Personal Archive Knowledge Base.
Ground your response directly in any matching past conversations or archive summaries (cite them clearly by conversation title).
If the archive does not contain the requested information, state that clearly and provide a concise, helpful response.
Be direct, factual, and concise.`;

        const userPromptContent = `USER INQUIRY:
"""
${userPost}
"""

PERSONAL ARCHIVE KNOWLEDGE BASE:
${archiveContext || 'No previous related records found in personal archive.'}`;

        let messageContent = userPromptContent;
        if (Array.isArray(images) && images.length > 0) {
          const imageParts = [];
          for (const img of images) {
            const part = this.fileToGenerativePart(img.file_path || img.filePath || img, img.mime_type || img.mimeType);
            if (part?.inlineData?.data) {
              imageParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                }
              });
            }
          }
          if (imageParts.length > 0) {
            messageContent = [
              { type: 'text', text: userPromptContent },
              ...imageParts
            ];
          }
        }

        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: targetModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: messageContent }
            ],
            max_tokens: 1500,
            temperature: 0.3
          }),
          signal: AbortSignal.timeout(180000) // 3-minute timeout for local model generation
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`LM Studio returned status ${resp.status}: ${errText}`);
        }
        const data = await resp.json();
        const resultText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || '';
        return {
          text: resultText || 'No response generated by local LM Studio model.',
          provider: 'lmstudio',
          model: targetModel
        };
      } catch (lmErr) {
        console.error(`[ProviderRouter] LM Studio local model (${targetModel}) error:`, lmErr.message);
        if (lmErr.name === 'TimeoutError' || lmErr.message.includes('timeout') || lmErr.name === 'AbortError') {
          throw new Error(`The local LM Studio model "${targetModel}" timed out while analyzing the archive (took longer than 3 minutes). The server is running, but generating the answer took too long.`);
        }
        throw new Error(`The local LM Studio model "${targetModel}" is not available at ${baseUrl}. Please ensure LM Studio local server is started and "${targetModel}" is loaded. To protect your data privacy, local archive analysis will never fall back to cloud AI or Google search.`);
      }
    }

    // 3. OPENAI CLOUD ROUTING
    if (provider === 'openai') {
      const client = this.getOpenAIClient();
      const completion = await client.chat.completions.create({
        model: model || 'gpt-4o',
        messages: [{ role: 'user', content: textPrompt }]
      });
      return {
        text: completion.choices[0]?.message?.content || '',
        provider: 'openai',
        model: model || 'gpt-4o'
      };
    }

    // 4. GOOGLE GEMINI CLOUD ROUTING
    if (provider === 'gemini') {
      const geminiKey = apiKey || process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        throw new Error('Google Gemini API Key is missing. Please configure your Gemini API Key in Settings to perform Gemini Archive AI Analysis.');
      }
      const geminiModel = this.ensureGeminiModel(model);
      const client = this.getGeminiClient(geminiKey);
      const response = await client.models.generateContent({
        model: geminiModel,
        contents
      });
      return {
        text: response.text || 'Unable to generate archive analysis at this time.',
        provider: 'gemini',
        model: geminiModel
      };
    }

    throw new Error(`Unsupported provider "${provider}". Please choose a local model (Ollama / LM Studio) or Google Gemini.`);
  }

  /**
   * Option 3: Google Search AI Grounding (with Multimodal Image Support)
   */
  async googleSearchAI({ query, images = [], model = 'gemini-3.8-flash', apiKey }) {
    const ai = this.getGeminiClient(apiKey);
    const geminiModel = this.ensureGeminiModel(model);
    console.log(`[Google Search AI] Executing search grounding query: "${query}" using model ${geminiModel}...`);

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

    const response = await ai.models.generateContent({
      model: geminiModel,
      contents,
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

    let summary = response.text || '';
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
