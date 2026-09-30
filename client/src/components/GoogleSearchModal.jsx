import React, { useState } from 'react';
import { 
  X, 
  Search, 
  Globe, 
  ExternalLink, 
  Copy, 
  Check, 
  ArrowRight, 
  PlusCircle, 
  MessageSquarePlus, 
  Sparkles,
  Loader2
} from 'lucide-react';
import { api } from '../api';
import FormattedText from './FormattedText';

export default function GoogleSearchModal({ 
  isOpen, 
  onClose, 
  activeConvId,
  onInsertIntoComposer,
  onPostToThread,
  onNewThreadWithContent,
  onSummarizeUrl
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleSummarizeAndClose = (url) => {
    onClose();
    if (onSummarizeUrl) {
      onSummarizeUrl(url);
    }
  };

  const handleSearch = async (e) => {
    if (e) e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await api.searchGoogleAI({ query: query.trim() });
      setResult(data);
    } catch (err) {
      console.error('Google AI Search error:', err);
      setError(err.message || 'Failed to complete Google Search AI request.');
    } finally {
      setLoading(false);
    }
  };

  const formatMarkdownOutput = () => {
    if (!result) return '';
    let text = `### Google Search AI Overview: "${result.query}"\n\n${result.summary}\n`;
    if (result.sources && result.sources.length > 0) {
      text += `\n**Sources & Citations:**\n`;
      // Deduplicate sources by URL
      const seen = new Set();
      result.sources.forEach((s) => {
        if (!seen.has(s.url)) {
          seen.add(s.url);
          text += `- [${s.title}](${s.url})\n`;
        }
      });
    }
    return text;
  };

  const handleCopy = () => {
    const text = formatMarkdownOutput();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsertComposer = () => {
    const text = formatMarkdownOutput();
    onInsertIntoComposer?.(text);
    onClose();
  };

  const handlePostDirect = async () => {
    if (!activeConvId) {
      handleNewThread();
      return;
    }
    const text = formatMarkdownOutput();
    await onPostToThread?.(text);
    onClose();
  };

  const handleNewThread = async () => {
    const text = formatMarkdownOutput();
    await onNewThreadWithContent?.({
      title: `Google AI: ${result.query.slice(0, 35)}`,
      content: text
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="google-search-modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header" style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="google-ai-badge-icon">
              <Globe size={18} color="#fff" />
            </div>
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                Google Search AI
                <span className="google-ai-live-pill">
                  <Sparkles size={11} /> Grounded
                </span>
              </h3>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                Live web search synthesized with Gemini AI Overviews & citations.
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="btn-modal-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search Input Bar */}
        <div style={{ padding: '18px 20px 14px' }}>
          <form onSubmit={handleSearch} className="google-search-input-form">
            <Search size={18} color="var(--text-muted)" style={{ marginLeft: '12px', flexShrink: 0 }} />
            <input 
              type="text"
              autoFocus
              className="google-search-input-field"
              placeholder="Ask Google anything (e.g. 'Latest breakthroughs in fusion energy', 'Current stock market rally reasons')..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button 
              type="submit" 
              className="google-search-submit-btn"
              disabled={!query.trim() || loading}
            >
              {loading ? (
                <>
                  <Loader2 size={14} className="spin-animate" />
                  <span>Searching...</span>
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  <span>Search</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Content Area */}
        <div className="google-search-modal-body">
          {error && (
            <div className="google-search-error-box">
              <p style={{ fontWeight: 600, marginBottom: '4px' }}>Search Error</p>
              <p style={{ fontSize: '13px' }}>{error}</p>
            </div>
          )}

          {loading && (
            <div className="google-search-loading-state">
              <div className="google-pulse-spinner">
                <Globe size={28} color="var(--accent-primary)" />
              </div>
              <p style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>
                Querying Google Search & Synthesizing AI Overview...
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Retrieving real-time web pages, fact checks, and source citations
              </p>
            </div>
          )}

          {!result && !loading && !error && (
            <div className="google-search-empty-state">
              <Globe size={36} color="var(--text-muted)" style={{ opacity: 0.6, marginBottom: '12px' }} />
              <h4 style={{ fontSize: '15px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Instant Web Search with AI Citations
              </h4>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '420px', lineHeight: 1.5 }}>
                Type your question above. Google AI will browse the live web, construct a concise synthesis, and provide clickable citations you can insert directly into your chats.
              </p>
            </div>
          )}

          {result && !loading && (
            <div className="google-search-results-wrap">
              {/* Web queries executed */}
              {result.searchQueries && result.searchQueries.length > 0 && (
                <div className="google-queries-chip-list">
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Google Searched:</span>
                  {result.searchQueries.map((q, idx) => (
                    <span key={idx} className="google-query-chip">
                      🔍 {q}
                    </span>
                  ))}
                </div>
              )}

              {/* AI Overview Box */}
              <div className="google-ai-overview-card">
                <div className="google-ai-overview-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Sparkles size={14} color="#a855f7" />
                    <span style={{ fontWeight: 600, fontSize: '13px', color: '#f3e8ff' }}>AI Overview</span>
                  </div>
                  <button 
                    onClick={handleCopy}
                    className="google-copy-btn"
                    title="Copy response markdown"
                  >
                    {copied ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>

                <div className="google-ai-overview-text">
                  <FormattedText text={result.summary} onSummarizeUrl={handleSummarizeAndClose} />
                </div>
              </div>

              {/* Citations & Sources */}
              {result.sources && result.sources.length > 0 && (
                <div className="google-sources-section">
                  <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
                    Citations & Web Sources ({result.sources.length})
                  </h4>
                  <div className="google-sources-grid">
                    {result.sources.map((s, idx) => (
                      <div key={idx} className="google-source-card-wrapper">
                        <a 
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="google-source-card"
                          title={s.url}
                        >
                          <span className="source-index">{idx + 1}</span>
                          <div className="source-info">
                            <span className="source-title">{s.title}</span>
                            <span className="source-url">
                              {new URL(s.url).hostname.replace('www.', '')}
                            </span>
                          </div>
                          <ExternalLink size={12} className="source-ext-icon" />
                        </a>
                        <button
                          type="button"
                          className="btn-source-card-summarize"
                          onClick={() => handleSummarizeAndClose(s.url)}
                          title="Please provide an AI summary of this page."
                        >
                          <Sparkles size={11} />
                          <span>Summarize page</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        {result && (
          <div className="google-search-modal-footer">
            <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button 
                type="button"
                className="btn-secondary"
                onClick={handleInsertComposer}
                title="Paste into chat input box to edit or comment on"
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <ArrowRight size={14} />
                <span>Insert into Composer</span>
              </button>

              {activeConvId && (
                <button 
                  type="button"
                  className="btn-primary"
                  onClick={handlePostDirect}
                  title="Directly add this AI search answer to the current active chat thread"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <MessageSquarePlus size={14} />
                  <span>Post to Current Thread</span>
                </button>
              )}

              <button 
                type="button"
                className="btn-secondary"
                onClick={handleNewThread}
                title="Start a fresh conversation thread with this topic"
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <PlusCircle size={14} />
                <span>New Conversation</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
