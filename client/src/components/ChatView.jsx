import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  Square, 
  Sparkles, 
  Database, 
  Cpu, 
  Clock, 
  ChevronDown,
  Info,
  Tag,
  SlidersHorizontal,
  Lock,
  Globe
} from 'lucide-react';
import { api } from '../api';
import TopicSelectionModal from './TopicSelectionModal';
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
  categories,
  onOpenGoogleSearch,
  externalInputText,
  setExternalInputText,
  onSummarizeUrl
}) {
  const [inputText, setInputText] = useState('');
  const [injectContext, setInjectContext] = useState(false);
  const [contextMode, setContextMode] = useState('summary'); // 'summary' | 'categories' | 'hybrid'
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([]);
  const [isTopicModalOpen, setIsTopicModalOpen] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

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

  const handleSubmit = () => {
    if (!inputText.trim() || isStreaming) return;
    onSendMessage({
      text: inputText,
      injectContext,
      contextMode,
      categoryIds: selectedCategoryIds
    });
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // Standard fallback models for each provider
  const defaultProviderModels = {
    gemini: ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
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

          {/* Context Injection Control Toggle */}
          <button 
            className={`context-toggle-btn ${injectContext ? 'active' : ''}`}
            onClick={() => setInjectContext(!injectContext)}
            title="Inject archive summaries & past discussions as contextual memory"
          >
            <Database size={14} />
            <span>Archive Memory: {injectContext ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      {/* Context Injection Sub-bar (shows if enabled) */}
      {injectContext && (
        <div className="context-banner">
          <span style={{ fontWeight: 600, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Sparkles size={14} /> Retrieval Mode:
          </span>
          <div className="context-modes">
            <button 
              className={`context-mode-btn ${contextMode === 'summary' ? 'selected' : ''}`}
              onClick={() => setContextMode('summary')}
            >
              Latest Summaries
            </button>
            <button 
              className={`context-mode-btn ${contextMode === 'categories' ? 'selected' : ''}`}
              onClick={() => {
                setContextMode('categories');
                setIsTopicModalOpen(true);
              }}
              title="Open window to choose knowledge topics for retrieval"
              style={{ display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <span>Selected Topics</span>
              {selectedCategoryIds.length > 0 && (
                <span style={{ 
                  background: contextMode === 'categories' ? 'rgba(255, 255, 255, 0.3)' : 'rgba(139, 92, 246, 0.3)',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  fontSize: '10px',
                  fontWeight: 600
                }}>
                  {selectedCategoryIds.length}
                </span>
              )}
            </button>
            <button 
              className={`context-mode-btn ${contextMode === 'hybrid' ? 'selected' : ''}`}
              onClick={() => setContextMode('hybrid')}
            >
              Smart Keyword FTS
            </button>
          </div>

          {contextMode === 'categories' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '6px' }}>
              <button
                onClick={() => setIsTopicModalOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '3px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 500,
                  background: 'rgba(139, 92, 246, 0.15)',
                  border: '1px solid rgba(139, 92, 246, 0.4)',
                  color: '#c4b5fd',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.25)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(139, 92, 246, 0.15)'}
                title="Click to open topic selection window"
              >
                <SlidersHorizontal size={12} />
                <span>
                  {selectedCategoryIds.length === 0 
                    ? 'Click to Select Topics (None chosen)' 
                    : `${selectedCategoryIds.length} topic${selectedCategoryIds.length === 1 ? '' : 's'} active — Edit`}
                </span>
              </button>

              {selectedCategoryIds.length > 0 && (
                <button
                  onClick={() => setSelectedCategoryIds([])}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    fontSize: '11px',
                    cursor: 'pointer',
                    padding: '2px 4px',
                    textDecoration: 'underline'
                  }}
                  title="Clear topic selection"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Message List */}
      <div className="messages-container">
        {messages.length === 0 && !isStreaming ? (
          <div className="chat-empty-state">
            <div className="empty-icon-wrap">
              <Sparkles size={28} />
            </div>
            <h3 className="empty-title">Personal AI Archive</h3>
            <p className="empty-subtitle">
              Ask anything across Gemini, OpenAI, or 100% offline local models (Ollama, LM Studio). 
              Every answer is automatically indexed, timestamped, and accessible forever in your personal local database.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message-bubble-wrap ${m.role}`}>
              <div className="message-sender-meta">
                {m.role === 'user' ? (
                  <span className="sender-user-label">You</span>
                ) : (
                  <div className="assistant-meta-tags">
                    <span className="badge-provider">
                      <Cpu size={11} style={{ marginRight: '3px' }} />
                      {m.provider ? m.provider.toUpperCase() : 'AI'}
                    </span>
                    <span className="badge-model">
                      {m.model || 'Default Model'}
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
              <div className={`message-bubble ${m.role} ${m.status === 'error' ? 'error-bubble' : ''}`}>
                <FormattedText text={m.content} onSummarizeUrl={onSummarizeUrl} />
              </div>
            </div>
          ))
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
        <div ref={messagesEndRef} />
      </div>

      {/* Input Composer */}
      <div className="chat-input-container">
        <div className="chat-input-box">
          <textarea 
            ref={textareaRef}
            className="chat-textarea"
            rows="1"
            placeholder={`Message ${selectedProvider}... (Press Enter to send, Shift+Enter for new line)`}
            value={inputText}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
          />
          <div className="chat-actions">
            <button
              type="button"
              className="btn-composer-search-ai"
              onClick={onOpenGoogleSearch}
              title="Search Google AI and insert into this message"
            >
              <Globe size={15} />
            </button>
            {isStreaming ? (
              <button className="btn-stop" onClick={onStopStreaming}>
                <Square size={14} />
                <span>Stop</span>
              </button>
            ) : (
              <button 
                className="btn-send" 
                onClick={handleSubmit}
                disabled={!inputText.trim()}
                style={{ opacity: inputText.trim() ? 1 : 0.5 }}
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Topic Selection Modal Window */}
      <TopicSelectionModal 
        isOpen={isTopicModalOpen}
        onClose={() => setIsTopicModalOpen(false)}
        categories={categories}
        selectedCategoryIds={selectedCategoryIds}
        onSelectionChange={setSelectedCategoryIds}
      />
    </div>
  );
}
