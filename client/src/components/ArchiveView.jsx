import React, { useState, useEffect } from 'react';
import { 
  Search, 
  Download, 
  Clock, 
  Calendar, 
  FolderArchive, 
  Tag, 
  Cpu, 
  ExternalLink,
  Filter,
  RefreshCw
} from 'lucide-react';
import { api } from '../api';
import FormattedText from './FormattedText';

export default function ArchiveView({ conversations, onSelectConversation, setCurrentView, onSummarizeUrl }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedProviderFilter, setSelectedProviderFilter] = useState('all');
  const [isSyncingObsidian, setIsSyncingObsidian] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState(null);

  const handleSyncObsidian = async () => {
    if (isSyncingObsidian) return;
    setIsSyncingObsidian(true);
    setSyncFeedback(null);
    try {
      const res = await api.syncObsidian();
      setSyncFeedback(`Synced! (+${res.importedCount} in, ${res.exportedCount} out)`);
      setTimeout(() => setSyncFeedback(null), 5000);
    } catch (err) {
      alert('Obsidian Sync Failed: ' + err.message);
    } finally {
      setIsSyncingObsidian(false);
    }
  };

  // Trigger FTS5 search when query changes
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const results = await api.searchArchive(searchQuery);
        setSearchResults(results);
      } catch (err) {
        console.error('Search error:', err);
      } finally {
        setIsSearching(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const filteredConversations = conversations.filter(c => {
    if (selectedProviderFilter === 'all') return true;
    return c.provider === selectedProviderFilter;
  });

  return (
    <div className="archive-view">
      {/* Header */}
      <div className="view-header">
        <div className="view-title-group">
          <h2>Archive Explorer</h2>
          <p>Local SQLite FTS5 Full-Text Search, timeline inspector, and portability exports.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <button 
            onClick={handleSyncObsidian}
            disabled={isSyncingObsidian}
            className="btn-primary"
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              background: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)',
              border: 'none',
              padding: '7px 14px',
              borderRadius: '8px',
              fontWeight: 600,
              fontSize: '13px',
              cursor: isSyncingObsidian ? 'not-allowed' : 'pointer'
            }}
            title="Two-way sync with local Obsidian Vault (DeanGVault)"
          >
            <RefreshCw size={14} className={isSyncingObsidian ? 'animate-spin' : ''} />
            <span>{isSyncingObsidian ? 'Syncing...' : syncFeedback || 'Sync Obsidian'}</span>
          </button>
          <a 
            href="/api/export/markdown" 
            download="Personal_AI_Archive_Obsidian_Vault.zip"
            className="btn-secondary"
            style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}
            title="Download full backup zip of all archive notes"
          >
            <Download size={14} />
            <span>Vault (.zip)</span>
          </a>
          <a 
            href="/api/export/json" 
            download
            className="btn-secondary"
            style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Download size={14} />
            <span>JSON Backup</span>
          </a>
        </div>
      </div>

      {/* Search Input */}
      <div className="archive-search-box">
        <Search size={18} color="var(--text-muted)" />
        <input 
          type="text"
          className="archive-search-input"
          placeholder="Search through all your past AI conversations using instant SQLite FTS5..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button 
            onClick={() => setSearchQuery('')}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '12px' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Results or Timeline view */}
      {searchQuery.trim() ? (
        <div>
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
            {isSearching ? 'Searching...' : `Search Results (${searchResults.length} matches)`}
          </h3>

          {searchResults.length === 0 && !isSearching ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              No messages matched "{searchQuery}".
            </div>
          ) : (
            searchResults.map((res) => (
              <div 
                key={res.id} 
                className="archive-card"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  onSelectConversation(res.conversation_id);
                  setCurrentView('chat');
                }}
              >
                <div className="archive-card-header">
                  <span className="archive-card-title">{res.conversation_title || 'Conversation'}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {res.role === 'assistant' && (
                      <span className="badge-provider" style={{ padding: '2px 8px', fontSize: '10px' }}>
                        <Cpu size={10} style={{ marginRight: '3px' }} />
                        {res.provider ? res.provider.toUpperCase() : 'AI'} : {res.model || 'model'}
                      </span>
                    )}
                    <span className="archive-card-meta">
                      {new Date(res.timestamp).toLocaleString()} • {res.role.toUpperCase()}
                    </span>
                  </div>
                </div>
                <div className="archive-card-content">
                  <FormattedText text={res.content} onSummarizeUrl={onSummarizeUrl} />
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div>
          {/* Filter Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Filter size={12} /> Filter Provider:
            </span>
            {['all', 'gemini', 'openai', 'ollama', 'lmstudio'].map((p) => (
              <button
                key={p}
                onClick={() => setSelectedProviderFilter(p)}
                style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  background: selectedProviderFilter === p ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  color: selectedProviderFilter === p ? '#fff' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  textTransform: 'capitalize'
                }}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Conversations Listing */}
          <h3 style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
            All Archived Threads ({filteredConversations.length})
          </h3>

          {filteredConversations.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              No conversations archived for this filter.
            </div>
          ) : (
            filteredConversations.map((c) => (
              <div 
                key={c.id} 
                className="archive-card"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  onSelectConversation(c.id);
                  setCurrentView('chat');
                }}
              >
                <div className="archive-card-header">
                  <span className="archive-card-title">{c.title || 'Untitled Conversation'}</span>
                  <span className="archive-card-meta">
                    Created {new Date(c.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                  <span className="badge-provider" style={{ padding: '2px 8px', fontSize: '10px' }}>
                    <Cpu size={10} style={{ marginRight: '3px' }} />
                    {c.default_provider || c.provider || 'AI'}
                  </span>
                  <span className="badge-model" style={{ padding: '2px 8px', fontSize: '10px' }}>
                    {c.default_model || c.model || 'default'}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    Thread ID: <code>{c.id.slice(0, 8)}</code>
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
