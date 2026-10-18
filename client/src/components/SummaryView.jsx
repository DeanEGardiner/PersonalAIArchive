import React, { useState, useEffect, useMemo } from 'react';
import { 
  Sparkles, 
  RefreshCw, 
  Bot,
  BookOpen, 
  Search, 
  ExternalLink,
  MessageSquare,
  Layers,
  Download,
  AlertCircle,
  Tag,
  CheckCircle2,
  Calendar,
  Filter
} from 'lucide-react';
import { api } from '../api';

export default function SummaryView({ 
  summaries = [], 
  onRefreshSummaries, 
  providerHealth,
  onNavigateToConversation,
  onNavigateToNote
}) {
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'ai_conversations' | 'obsidian_notes'
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedEntityFilter, setSelectedEntityFilter] = useState(null);

  // Generation Controls State
  const [genCorpus, setGenCorpus] = useState('ai_conversations'); // 'ai_conversations' | 'obsidian_notes' | 'all'
  const [genMode, setGenMode] = useState('incremental');
  const [genProvider, setGenProvider] = useState('gemini');
  const [genModel, setGenModel] = useState('gemini-3.8-flash');
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [successToast, setSuccessToast] = useState(null);

  // Pending counts
  const [pendingStats, setPendingStats] = useState(null);

  // Obsidian sync state
  const [isSyncingObsidian, setIsSyncingObsidian] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState(null);

  useEffect(() => {
    loadPendingPreview();
  }, [genMode]);

  const loadPendingPreview = async () => {
    try {
      const p = await api.getDigestsPreview(genMode);
      setPendingStats(p);
    } catch (_) {}
  };

  const isChatModel = (modelName) => {
    if (!modelName || typeof modelName !== 'string') return false;
    const lower = modelName.toLowerCase();
    return !lower.includes('embed') && !lower.includes('bge-') && !lower.includes('e5-');
  };

  const availableModels = useMemo(() => {
    const raw = providerHealth?.[genProvider]?.models || [];
    return raw.filter(isChatModel);
  }, [providerHealth, genProvider]);

  // Sync default model when provider or availableModels changes
  useEffect(() => {
    if (availableModels.length > 0) {
      if (!availableModels.includes(genModel)) {
        setGenModel(availableModels[0]);
      }
    } else {
      if (genProvider === 'gemini') setGenModel('gemini-3.8-flash');
      else if (genProvider === 'openai') setGenModel('gpt-4o-mini');
      else if (genProvider === 'lmstudio') setGenModel('qwen/qwen3.8-27b');
      else if (genProvider === 'ollama') setGenModel('gemma4:12b-mlx');
    }
  }, [genProvider, availableModels]);

  const handleSyncObsidian = async () => {
    if (isSyncingObsidian) return;
    setIsSyncingObsidian(true);
    setSyncFeedback(null);
    try {
      const res = await api.syncObsidian();
      setSyncFeedback(`Synced! (+${res.importedCount} in, ${res.exportedCount} out)`);
      setTimeout(() => setSyncFeedback(null), 5000);
      loadPendingPreview();
    } catch (err) {
      alert('Obsidian Sync Failed: ' + err.message);
    } finally {
      setIsSyncingObsidian(false);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setErrorMsg(null);
    setSuccessToast(null);
    try {
      const res = await api.generateDigests({
        corpus: genCorpus,
        mode: genMode,
        overrideProvider: genProvider,
        overrideModel: genModel
      });

      await onRefreshSummaries();
      await loadPendingPreview();

      const corpusLabel = genCorpus === 'ai_conversations' ? 'AI Conversations' : (genCorpus === 'obsidian_notes' ? 'Obsidian Vault' : 'All Data');
      setSuccessToast(`Search digests successfully updated for ${corpusLabel}!`);
      setTimeout(() => setSuccessToast(null), 6000);
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Filtered digests calculation
  const filteredDigests = useMemo(() => {
    return (summaries || []).filter((item) => {
      // Tab filter
      if (activeTab !== 'all' && item.corpus_type !== activeTab) {
        return false;
      }

      // Entity chip filter (guarded against objects)
      if (selectedEntityFilter) {
        const entities = Array.isArray(item.entities) ? item.entities : [];
        const hasMatch = entities.some(e => {
          const str = typeof e === 'string' ? e : (e?.name || '');
          return str && str.toLowerCase() === selectedEntityFilter.toLowerCase();
        });
        if (!hasMatch) return false;
      }

      // Keyword text filter (guarded against objects)
      if (searchFilter.trim()) {
        const q = searchFilter.toLowerCase();
        const inTitle = (item.title || '').toLowerCase().includes(q);
        const inText = (item.summary_text || '').toLowerCase().includes(q);
        const inEntities = (item.entities || []).some(e => {
          const str = typeof e === 'string' ? e : (e?.name || '');
          return str && str.toLowerCase().includes(q);
        });
        const inRefs = (item.references || []).some(r => {
          const str = typeof r === 'string' ? r : (r?.title || r?.rel_path || '');
          return str && str.toLowerCase().includes(q);
        });
        if (!inTitle && !inText && !inEntities && !inRefs) {
          return false;
        }
      }

      return true;
    });
  }, [summaries, activeTab, searchFilter, selectedEntityFilter]);

  const convCount = (summaries || []).filter(s => s.corpus_type === 'ai_conversations').length;
  const obsidianCount = (summaries || []).filter(s => s.corpus_type === 'obsidian_notes').length;

  return (
    <div className="summary-view" style={{ padding: '24px 32px' }}>
      {/* View Header */}
      <div className="view-header" style={{ marginBottom: '20px' }}>
        <div className="view-title-group">
          <h2>AI Search Digests & Knowledge Map</h2>
          <p>Entity-dense, provenance-linked digests designed to optimize coarse-to-fine AI retrieval over chats and notes.</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Target Corpus Selector */}
          <select
            value={genCorpus}
            onChange={(e) => setGenCorpus(e.target.value)}
            className="model-select"
            title="Choose which data corpus to summarize"
            style={{ fontWeight: 600 }}
          >
            <option value="ai_conversations">Target: 🤖 AI Chats ({pendingStats?.ai_conversations?.count ?? 0} new)</option>
            <option value="obsidian_notes">Target: 📓 Obsidian Notes ({pendingStats?.obsidian_notes?.count ?? 0} notes)</option>
            <option value="all">Target: 🌐 All Corpora</option>
          </select>

          {/* Provider Selector */}
          <select
            value={genProvider}
            onChange={(e) => setGenProvider(e.target.value)}
            className="model-select"
          >
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama (Local)</option>
            <option value="lmstudio">LM Studio (Local)</option>
          </select>

          {/* Model Selector */}
          <select
            value={genModel}
            onChange={(e) => setGenModel(e.target.value)}
            className="model-select"
          >
            {availableModels.length > 0 ? (
              availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))
            ) : (
              <option value={genModel}>{genModel}</option>
            )}
          </select>

          {/* Mode Selector */}
          <select
            value={genMode}
            onChange={(e) => setGenMode(e.target.value)}
            className="model-select"
          >
            <option value="incremental">Incremental (New Only)</option>
            <option value="full">Full Re-run (All History)</option>
          </select>

          {/* Primary Action Button */}
          <button 
            className="btn-primary"
            onClick={handleGenerate}
            disabled={isGenerating}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={14} className={isGenerating ? 'animate-spin' : ''} />
            <span>{isGenerating ? 'Synthesizing...' : `Generate Digest`}</span>
          </button>

          {/* Sync Obsidian Button */}
          <button 
            onClick={handleSyncObsidian}
            disabled={isSyncingObsidian}
            className="btn-secondary"
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              background: 'rgba(168, 85, 247, 0.15)',
              borderColor: 'rgba(168, 85, 247, 0.35)',
              color: '#d8b4fe',
              fontWeight: 600,
              fontSize: '13px'
            }}
            title="Sync with local Obsidian Vault"
          >
            <RefreshCw size={14} className={isSyncingObsidian ? 'animate-spin' : ''} />
            <span>{isSyncingObsidian ? 'Syncing...' : syncFeedback || 'Sync Obsidian'}</span>
          </button>

          {/* Vault Export Link */}
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
        </div>
      </div>

      {/* Notifications */}
      {errorMsg && (
        <div style={{ 
          padding: '12px 16px', 
          borderRadius: '8px', 
          background: 'rgba(239, 68, 68, 0.15)', 
          border: '1px solid rgba(239, 68, 68, 0.3)',
          color: '#fca5a5',
          fontSize: '13px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <AlertCircle size={16} />
          <span>{errorMsg}</span>
        </div>
      )}

      {successToast && (
        <div style={{ 
          padding: '12px 16px', 
          borderRadius: '8px', 
          background: 'rgba(16, 185, 129, 0.15)', 
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#6ee7b7',
          fontSize: '13px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <CheckCircle2 size={16} />
          <span>{successToast}</span>
        </div>
      )}

      {/* Search & Tabs Toolbar */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between', 
        gap: '16px', 
        marginBottom: '20px',
        flexWrap: 'wrap'
      }}>
        {/* Corpus Navigation Tabs */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setActiveTab('all')}
            className={`nav-tab ${activeTab === 'all' ? 'active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
          >
            <Layers size={14} />
            <span>All Digests ({summaries.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('ai_conversations')}
            className={`nav-tab ${activeTab === 'ai_conversations' ? 'active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
          >
            <Bot size={14} color="#a78bfa" />
            <span>AI Chats ({convCount})</span>
          </button>

          <button
            onClick={() => setActiveTab('obsidian_notes')}
            className={`nav-tab ${activeTab === 'obsidian_notes' ? 'active' : ''}`}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
          >
            <BookOpen size={14} color="#67e8f9" />
            <span>Obsidian Vault ({obsidianCount})</span>
          </button>
        </div>

        {/* Search Bar */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px', 
          background: 'var(--bg-secondary)', 
          border: '1px solid var(--border-subtle)', 
          borderRadius: '8px',
          padding: '6px 12px',
          minWidth: '280px'
        }}>
          <Search size={14} color="var(--text-muted)" />
          <input 
            type="text"
            placeholder="Filter digests by topic, entity, or keyword..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              fontSize: '13px',
              outline: 'none',
              width: '100%'
            }}
          />
          {searchFilter && (
            <button 
              onClick={() => setSearchFilter('')}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '12px' }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Active Filter Pill */}
      {selectedEntityFilter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Filtered by entity:</span>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            borderRadius: '16px',
            background: 'rgba(139, 92, 246, 0.25)',
            border: '1px solid rgba(139, 92, 246, 0.45)',
            color: '#c4b5fd',
            fontSize: '12px',
            fontWeight: 600
          }}>
            <Tag size={12} />
            {selectedEntityFilter}
            <button 
              onClick={() => setSelectedEntityFilter(null)}
              style={{ background: 'none', border: 'none', color: '#c4b5fd', cursor: 'pointer', marginLeft: '4px' }}
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* Digest Cards Stream */}
      {filteredDigests.length === 0 ? (
        <div style={{ 
          padding: '60px 20px', 
          textAlign: 'center', 
          background: 'var(--bg-secondary)', 
          borderRadius: '12px',
          border: '1px dashed var(--border-subtle)' 
        }}>
          <Layers size={40} color="var(--text-muted)" style={{ margin: '0 auto 16px', opacity: 0.6 }} />
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', marginBottom: '8px' }}>
            {searchFilter || selectedEntityFilter ? 'No matching digests found' : 'No search digests generated yet'}
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', maxWidth: '480px', margin: '0 auto 20px' }}>
            {searchFilter || selectedEntityFilter 
              ? 'Try adjusting your search terms or clearing the active filter.' 
              : 'Generate an AI search digest above to build an entity-dense retrieval map over your conversations and Obsidian notes.'}
          </p>
          {(searchFilter || selectedEntityFilter) && (
            <button
              className="btn-secondary"
              onClick={() => { setSearchFilter(''); setSelectedEntityFilter(null); }}
            >
              Clear Filters
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {filteredDigests.map((digest) => {
            const isObsidian = digest.corpus_type === 'obsidian_notes';
            const entities = Array.isArray(digest.entities) ? digest.entities : [];
            const references = Array.isArray(digest.references) ? digest.references : [];

            return (
              <div 
                key={digest.id} 
                className="archive-card"
                style={{ 
                  borderLeft: isObsidian ? '4px solid #06b6d4' : '4px solid #8b5cf6',
                  transition: 'transform 0.15s ease, border-color 0.15s ease'
                }}
              >
                {/* Header */}
                <div className="archive-card-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      padding: '3px 8px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      background: isObsidian ? 'rgba(6, 182, 212, 0.15)' : 'rgba(139, 92, 246, 0.15)',
                      color: isObsidian ? '#67e8f9' : '#c4b5fd',
                      border: `1px solid ${isObsidian ? 'rgba(6, 182, 212, 0.3)' : 'rgba(139, 92, 246, 0.3)'}`
                    }}>
                      {isObsidian ? <BookOpen size={11} /> : <Bot size={11} />}
                      {isObsidian ? 'Obsidian Vault' : 'AI Chats'}
                    </span>
                    <span className="archive-card-title" style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>
                      {digest.title || 'Search Digest'}
                    </span>
                  </div>

                  <span className="archive-card-meta" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {digest.updated_at ? new Date(digest.updated_at).toLocaleDateString() : ''}
                  </span>
                </div>

                {/* Summary Body */}
                <div 
                  className="archive-card-content" 
                  style={{ 
                    whiteSpace: 'pre-wrap', 
                    lineHeight: '1.7', 
                    fontSize: '13.5px',
                    color: '#e2e8f0', 
                    marginTop: '12px',
                    marginBottom: '16px' 
                  }}
                >
                  {digest.summary_text}
                </div>

                {/* Extracted Entities Index Chips */}
                {entities.length > 0 && (
                  <div style={{ marginBottom: '16px' }}>
                    <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <Tag size={12} />
                      <span>Indexed Entities & Concepts ({entities.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {entities.map((rawEnt, idx) => {
                        const ent = typeof rawEnt === 'string' ? rawEnt : (rawEnt?.name || String(rawEnt || ''));
                        if (!ent) return null;
                        return (
                          <button
                            key={idx}
                            onClick={() => setSelectedEntityFilter(ent === selectedEntityFilter ? null : ent)}
                            style={{
                              background: selectedEntityFilter === ent ? 'rgba(139, 92, 246, 0.35)' : 'rgba(255, 255, 255, 0.05)',
                              border: `1px solid ${selectedEntityFilter === ent ? 'rgba(139, 92, 246, 0.6)' : 'rgba(255, 255, 255, 0.1)'}`,
                              color: selectedEntityFilter === ent ? '#fff' : 'var(--text-secondary)',
                              borderRadius: '6px',
                              padding: '3px 8px',
                              fontSize: '11.5px',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease'
                            }}
                            title={`Filter digests containing "${ent}"`}
                          >
                            {ent}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Direct Provenance Links */}
                {references.length > 0 && (
                  <div style={{ 
                    paddingTop: '12px', 
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}>
                    <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <ExternalLink size={12} />
                      <span>Direct Provenance References ({references.length})</span>
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {references.map((ref, rIdx) => {
                        const isNote = ref.type === 'obsidian_note';
                        return (
                          <button
                            key={rIdx}
                            onClick={() => {
                              if (isNote) {
                                if (onNavigateToNote) onNavigateToNote(ref.id || ref.rel_path, ref.title || ref.name || '');
                              } else {
                                if (onNavigateToConversation) onNavigateToConversation(ref.id);
                              }
                            }}
                            className="btn-secondary"
                            style={{
                              padding: '5px 10px',
                              fontSize: '12px',
                              borderRadius: '6px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              background: isNote ? 'rgba(6, 182, 212, 0.08)' : 'rgba(139, 92, 246, 0.08)',
                              borderColor: isNote ? 'rgba(6, 182, 212, 0.25)' : 'rgba(139, 92, 246, 0.25)',
                              color: isNote ? '#67e8f9' : '#c4b5fd',
                              cursor: 'pointer'
                            }}
                            title={`Jump to ${isNote ? 'Obsidian Note' : 'Conversation'}`}
                          >
                            {isNote ? <BookOpen size={12} /> : <MessageSquare size={12} />}
                            <span style={{ maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {ref.title || ref.rel_path || 'Source Link'}
                            </span>
                            <span style={{ opacity: 0.6 }}>→</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
