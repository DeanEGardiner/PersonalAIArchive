import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  Square, 
  Sparkles, 
  Cpu, 
  Clock, 
  ChevronDown,
  Info,
  Tag,
  Lock,
  Globe,
  Paperclip,
  X,
  ExternalLink
} from 'lucide-react';
import { api } from '../api';
import FormattedText from './FormattedText';

export default function ChatView({
  activeConvId,
  conversation,
  messages,
  onSendMessage,
  onStopStreaming,
  isStreaming,
  streamingText,
  providerHealth,
  selectedProvider,
  setSelectedProvider,
  selectedModel,
  setSelectedModel,
  onOpenGoogleSearch,
  externalInputText,
  setExternalInputText,
  onSummarizeUrl,
  onSubmitPost,
  isSubmitting = false
}) {
  const [inputText, setInputText] = useState('');
  const [postMode, setPostMode] = useState('standard'); // 'standard' | 'ai_analysis' | 'google_search'
  const [attachedImage, setAttachedImage] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, isSubmitting]);

  // Sync external input (e.g. from Google Search modal insertion)
  useEffect(() => {
    if (externalInputText !== undefined && externalInputText !== null && externalInputText !== '') {
      setInputText((prev) => {
        const separator = prev.trim() ? '\n\n' : '';
        return prev + separator + externalInputText;
      });
      setExternalInputText?.('');
      if (textareaRef.current) {
        setTimeout(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
            textareaRef.current.focus();
          }
        }, 50);
      }
    }
  }, [externalInputText, setExternalInputText]);

  // Handle Image Upload Selection
  const handleImageSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await api.uploadImage(formData);
      setAttachedImage(res);
    } catch (err) {
      alert('Failed to upload image: ' + err.message);
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Adjust textarea height dynamically
  const handleTextChange = (e) => {
    setInputText(e.target.value);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`;
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!inputText.trim() || isSubmitting || isStreaming) return;

    if (onSubmitPost) {
      await onSubmitPost({
        content: inputText.trim(),
        mode: postMode,
        attachment: attachedImage
      });
      setInputText('');
      setAttachedImage(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    } else {
      onSendMessage({
        text: inputText
      });
      setInputText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  // Standard fallback models for each provider
  const defaultProviderModels = {
    gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'gpt-4-turbo'],
    ollama: ['gemma4:12b-mlx', 'gemma:latest', 'qwen3.6:27b-mlx'],
    lmstudio: ['qwen/qwen3.8-27b', 'google/gemma-4-12b']
  };

  // Available models for current provider
  const availableModels = (providerHealth?.[selectedProvider]?.models?.length > 0) 
    ? providerHealth[selectedProvider].models 
    : (defaultProviderModels[selectedProvider] || []);

  // Once a model is used in the conversation, grey out and lock model selection
  const isModelLocked = (messages && messages.length > 0) || isStreaming;

  return (
    <div className="chat-view">
      {/* Top Header Controls */}
      <div className="chat-header">
        <div className="header-left-group">
          {conversation?.title && (
            <div className="chat-active-thread-title" title={conversation.title}>
              {conversation.title}
            </div>
          )}
          <div className="model-selector-bar">
            {/* Provider selector */}
            <select 
              className="model-select"
              value={selectedProvider}
              disabled={isModelLocked}
              title={isModelLocked ? "Provider cannot be changed once a conversation has started" : "Select AI Provider"}
              onChange={(e) => {
                const newProv = e.target.value;
                setSelectedProvider(newProv);
                const models = (providerHealth?.[newProv]?.models?.length > 0) 
                  ? providerHealth[newProv].models 
                  : (defaultProviderModels[newProv] || []);
                if (models.length > 0) setSelectedModel(models[0]);
              }}
            >
              <option value="gemini">Google Gemini (Cloud)</option>
              <option value="openai">OpenAI (ChatGPT)</option>
              <option value="ollama">Ollama (Local)</option>
              <option value="lmstudio">LM Studio (Local)</option>
            </select>

            {/* Model selector */}
            <select 
              className="model-select"
              value={selectedModel}
              disabled={isModelLocked}
              title={isModelLocked ? "Model cannot be changed once a conversation has started" : "Select Model"}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {availableModels.length > 0 ? (
                availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))
              ) : (
                <option value={selectedModel}>{selectedModel || 'Default Model'}</option>
              )}
            </select>

            {isModelLocked && (
              <span 
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  padding: '4px 8px',
                  borderRadius: '6px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)'
                }}
                title="Model is locked for this conversation to maintain context consistency"
              >
                <Lock size={11} />
                <span>Locked</span>
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Google Search AI Action Button */}
          <button 
            className="btn-google-search-chat"
            onClick={onOpenGoogleSearch}
            title="Search Google with AI Overviews and insert findings directly into this thread"
          >
            <Globe size={14} color="#a855f7" />
            <span>Google Search AI</span>
          </button>
        </div>
      </div>

      {/* Message List */}
      <div className="messages-container">
        {messages.length === 0 && !isStreaming && !isSubmitting ? (
          <div className="chat-empty-state">
            <div className="empty-icon-wrap">
              <Sparkles size={28} />
            </div>
            <h3 className="empty-title">Personal AI Archive</h3>
            <p className="empty-subtitle">
              Capture your ideas with full data ownership. You can post directly into your private archive, 
              synthesize answers grounded in your local database, or retrieve live facts with Google Cloud Search AI.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const isAIAnalysis = m.post_type === 'ai_analysis';
            const isGoogleSearch = m.post_type === 'google_search';

            // Check if message content contains Sources & Citations section
            const sourcesMarker = '**Sources & Citations:**';
            let bodyContent = m.content || '';
            let sourcesList = [];

            if (bodyContent.includes(sourcesMarker)) {
              const parts = bodyContent.split(sourcesMarker);
              bodyContent = parts[0].trim();
              const sourcesText = parts.slice(1).join(sourcesMarker).trim();
              if (sourcesText) {
                const linkRegex = /-\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
                let match;
                while ((match = linkRegex.exec(sourcesText)) !== null) {
                  sourcesList.push({
                    title: match[1],
                    url: match[2]
                  });
                }
              }
            }

            return (
              <div 
                key={m.id} 
                className={`message-bubble-wrap ${m.role} ${isAIAnalysis ? 'is-ai-analysis' : ''} ${isGoogleSearch ? 'is-google-search' : ''}`}
              >
                <div className="message-sender-meta">
                  {m.role === 'user' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className="sender-user-label">You</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>• Post</span>
                    </div>
                  ) : (
                    <div className="assistant-meta-tags">
                      {isAIAnalysis ? (
                        <span className="badge-provider badge-archive-analysis">
                          <Sparkles size={11} style={{ marginRight: '3px' }} />
                          LOCAL ARCHIVE ANALYSIS
                        </span>
                      ) : isGoogleSearch ? (
                        <span className="badge-provider badge-google-search">
                          <Globe size={11} style={{ marginRight: '3px' }} />
                          GOOGLE SEARCH AI
                        </span>
                      ) : (
                        <span className="badge-provider">
                          <Cpu size={11} style={{ marginRight: '3px' }} />
                          {m.provider ? m.provider.toUpperCase() : 'AI'}
                        </span>
                      )}
                      <span className="badge-model">
                        {m.model || (isGoogleSearch ? 'Gemini Grounded' : selectedModel)}
                      </span>
                    </div>
                  )}

                  {m.timestamp && (
                    <span className="message-time">
                      <Clock size={10} style={{ marginRight: '2px' }} />
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {m.status === 'interrupted' && (
                    <span style={{ color: 'var(--warning)', fontWeight: 600, fontSize: '10px' }}>(Interrupted)</span>
                  )}
                  {m.status === 'error' && (
                    <span style={{ color: 'var(--error)', fontWeight: 600, fontSize: '10px' }}>(Error)</span>
                  )}
                </div>

                <div className={`message-bubble ${m.role} ${m.status === 'error' ? 'error-bubble' : ''} ${isAIAnalysis ? 'bubble-ai-analysis' : ''} ${isGoogleSearch ? 'bubble-google-search' : ''}`}>
                  {/* Embedded image attachments */}
                  {Array.isArray(m.attachments) && m.attachments.length > 0 && (
                    <div className="post-attachments-gallery" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      {m.attachments.map((att, i) => (
                        <a key={i} href={att.file_path} target="_blank" rel="noopener noreferrer">
                          <img 
                            src={att.file_path} 
                            alt={att.file_name || 'Attachment'} 
                            style={{ maxHeight: '140px', borderRadius: '8px', border: '1px solid var(--border-subtle)', objectFit: 'cover' }} 
                          />
                        </a>
                      ))}
                    </div>
                  )}

                  <FormattedText text={bodyContent} onSummarizeUrl={onSummarizeUrl} />

                  {/* Verified Web Citations Grid */}
                  {sourcesList.length > 0 && (
                    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                      <div style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        color: 'var(--text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.6px',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}>
                        <Globe size={12} color="#4285F4" />
                        <span>Verified Citations & Sources ({sourcesList.length})</span>
                      </div>
                      <div className="google-sources-grid">
                        {sourcesList.map((s, idx) => {
                          let domain = '';
                          try {
                            domain = new URL(s.url).hostname.replace('www.', '');
                          } catch (e) {
                            domain = s.title;
                          }
                          return (
                            <a
                              key={idx}
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="google-source-card"
                              title={s.url}
                            >
                              <span className="source-index">{idx + 1}</span>
                              <div className="source-info">
                                <span className="source-title">{s.title}</span>
                                <span className="source-url">{domain}</span>
                              </div>
                              <ExternalLink size={12} className="source-ext-icon" />
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {/* Live streaming message */}
        {isStreaming && (
          <div className="message-bubble-wrap assistant">
            <div className="message-sender-meta">
              <div className="assistant-meta-tags">
                <span className="badge-provider">
                  <Cpu size={11} style={{ marginRight: '3px' }} />
                  {selectedProvider.toUpperCase()}
                </span>
                <span className="badge-model">
                  {selectedModel}
                </span>
              </div>
              <span className="badge-streaming">• Streaming live...</span>
            </div>
            <div className="message-bubble assistant">
              <FormattedText text={streamingText} onSummarizeUrl={onSummarizeUrl} />
              <span className="streaming-cursor" />
            </div>
          </div>
        )}

        {/* Async Submission Processing Card (Matching Community AI Archive) */}
        {isSubmitting && (
          <div className="message-bubble-wrap assistant" style={{ marginTop: '8px' }}>
            <div
              className={postMode === 'google_search' ? 'search-processing-card' : postMode === 'ai_analysis' ? 'ai-processing-card' : ''}
              style={{
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
                padding: '12px 18px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '12px',
                width: 'fit-content',
                maxWidth: '650px'
              }}
            >
              <div style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: postMode === 'google_search' ? '#4285F4' : 'var(--accent-gradient)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                flexShrink: 0
              }}>
                {postMode === 'google_search' ? <Globe size={16} className="spin-icon" /> : <Sparkles size={16} className="spin-icon" />}
              </div>
              <div>
                <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#fff' }}>
                  {postMode === 'google_search'
                    ? 'Querying Google Cloud Search AI...'
                    : postMode === 'ai_analysis'
                    ? 'Synthesizing Personal Archive with AI...'
                    : 'Posting to personal archive...'}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                  {postMode === 'google_search'
                    ? 'Retrieving live web grounding sources and generating overview...'
                    : postMode === 'ai_analysis'
                    ? 'Searching SQLite FTS5 personal archive knowledge base...'
                    : 'Saving message to local SQLite database...'}
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Composer */}
      <div className="chat-input-container">
        {/* Attached image preview */}
        {attachedImage && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
            padding: '4px 10px 4px 6px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '8px',
            width: 'fit-content'
          }}>
            <img 
              src={attachedImage.file_path} 
              alt="Attachment" 
              style={{ height: '36px', width: '36px', borderRadius: '4px', objectFit: 'cover' }} 
            />
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {attachedImage.file_name}
            </span>
            <button
              type="button"
              onClick={() => setAttachedImage(null)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: '2px'
              }}
              title="Remove attachment"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="chat-input-box">
          <textarea 
            ref={textareaRef}
            className="chat-textarea"
            rows="1"
            placeholder={
              postMode === 'standard'
                ? "Write a post or note to your personal archive... (Press Enter to post)"
                : postMode === 'ai_analysis'
                ? "Ask a question to analyze across your personal archive... (Press Enter to analyze)"
                : "Enter search query for Google Cloud AI... (Press Enter to search)"
            }
            value={inputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
          />

          {/* Hidden image input */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageSelect}
            accept="image/*"
            style={{ display: 'none' }}
          />

          <div className="chat-actions">
            {/* Attach Image Button */}
            <button
              type="button"
              className="btn-attach-image"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingImage || isSubmitting}
              style={{
                background: 'transparent',
                border: 'none',
                color: attachedImage ? 'var(--accent-secondary)' : 'var(--text-muted)',
                cursor: (uploadingImage || isSubmitting) ? 'not-allowed' : 'pointer',
                padding: '6px',
                display: 'flex',
                alignItems: 'center'
              }}
              title="Attach and embed image in post"
            >
              <Paperclip size={16} />
            </button>

            {/* Google Search AI Modal Trigger */}
            <button
              type="button"
              className="btn-composer-search-ai"
              onClick={onOpenGoogleSearch}
              title="Search Google AI and insert findings into this message"
            >
              <Globe size={15} />
            </button>
          </div>
        </div>

        {/* Triple Action Selector & Submit Bar (Matching Community AI Archive) */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginTop: '10px', 
          flexWrap: 'wrap', 
          gap: '10px' 
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: '2px' }}>
              Submission Mode:
            </span>
            <button
              type="button"
              onClick={() => setPostMode('standard')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid',
                borderColor: postMode === 'standard' ? 'var(--accent-primary)' : 'var(--border-subtle)',
                background: postMode === 'standard' ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg-tertiary)',
                color: postMode === 'standard' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              1. Just Post As Is
            </button>
            <button
              type="button"
              onClick={() => setPostMode('ai_analysis')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid',
                borderColor: postMode === 'ai_analysis' ? 'var(--accent-primary)' : 'var(--border-subtle)',
                background: postMode === 'ai_analysis' ? 'rgba(139, 92, 246, 0.2)' : 'var(--bg-tertiary)',
                color: postMode === 'ai_analysis' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease'
              }}
            >
              <Sparkles size={13} color="var(--accent-primary)" />
              2. Analysis of Local Archive
            </button>
            <button
              type="button"
              onClick={() => setPostMode('google_search')}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                border: '1px solid',
                borderColor: postMode === 'google_search' ? '#4285F4' : 'var(--border-subtle)',
                background: postMode === 'google_search' ? 'rgba(66, 133, 244, 0.2)' : 'var(--bg-tertiary)',
                color: postMode === 'google_search' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease'
              }}
            >
              <Globe size={13} color="#4285F4" />
              3. Google Cloud Search
            </button>
          </div>

          <div>
            {isStreaming ? (
              <button className="btn-stop" onClick={onStopStreaming}>
                <Square size={14} />
                <span>Stop</span>
              </button>
            ) : (
              <button 
                type="button"
                onClick={handleSubmit}
                disabled={!inputText.trim() || isSubmitting}
                style={{
                  padding: '8px 18px',
                  borderRadius: '8px',
                  background: 'var(--accent-gradient)',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 600,
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: (!inputText.trim() || isSubmitting) ? 'not-allowed' : 'pointer',
                  opacity: (!inputText.trim() || isSubmitting) ? 0.6 : 1,
                  boxShadow: '0 2px 8px rgba(139, 92, 246, 0.3)',
                  transition: 'all 0.15s ease'
                }}
              >
                {isSubmitting ? (
                  <>
                    <Sparkles size={14} className="spin-icon" />
                    <span>Processing...</span>
                  </>
                ) : postMode === 'standard' ? (
                  <>
                    <span>Post As Is</span>
                    <Send size={13} />
                  </>
                ) : postMode === 'ai_analysis' ? (
                  <>
                    <Sparkles size={13} />
                    <span>Post & Analyze Archive</span>
                  </>
                ) : (
                  <>
                    <Globe size={13} />
                    <span>Post & Google Search</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
