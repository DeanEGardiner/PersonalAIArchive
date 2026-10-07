import React, { useState, useEffect } from 'react';
import { 
  Sparkles, 
  RefreshCw, 
  Layers, 
  Tag, 
  Clock, 
  BookOpen,
  FileText,
  AlertCircle,
  Download
} from 'lucide-react';
import { api } from '../api';

export default function SummaryView({ summaries, categories, onRefreshSummaries, providerHealth }) {
  const [globalSummary, setGlobalSummary] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genMode, setGenMode] = useState('incremental');
  const [genProvider, setGenProvider] = useState('gemini');
  const [genModel, setGenModel] = useState('gemini-3.6-flash');
  const [errorMsg, setErrorMsg] = useState(null);
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

  // Sync default model when provider or providerHealth changes
  useEffect(() => {
    const models = providerHealth?.[genProvider]?.models || [];
    if (models.length > 0) {
      if (!models.includes(genModel)) {
        setGenModel(models[0]);
      }
    } else {
      if (genProvider === 'gemini') setGenModel('gemini-3.6-flash');
      else if (genProvider === 'openai') setGenModel('gpt-4o-mini');
      else if (genProvider === 'lmstudio') setGenModel('qwen/qwen3.8-27b');
      else if (genProvider === 'ollama') setGenModel('gemma4:12b-mlx');
    }
  }, [genProvider, providerHealth]);

  useEffect(() => {
    loadGlobal();
  }, [summaries]);

  const loadGlobal = async () => {
    try {
      const g = await api.getGlobalSummary();
      setGlobalSummary(g);
    } catch (e) {
      console.error(e);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setErrorMsg(null);
    try {
      await api.generateSummaries({
        mode: genMode,
        overrideProvider: genProvider,
        overrideModel: genModel
      });
      await onRefreshSummaries();
      await loadGlobal();
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const availableModels = providerHealth?.[genProvider]?.models || [];

  return (
    <div className="summary-view">
      {/* Header */}
      <div className="view-header">
        <div className="view-title-group">
          <h2>Archive Digest & Topic Categorization</h2>
          <p>Automated AI background summarization pipeline and topic extraction across conversations.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
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

          <select
            value={genMode}
            onChange={(e) => setGenMode(e.target.value)}
            className="model-select"
          >
            <option value="incremental">Incremental (New Only)</option>
            <option value="full">Full Re-run (All History)</option>
          </select>

          <button 
            className="btn-primary"
            onClick={handleGenerate}
            disabled={isGenerating}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={14} className={isGenerating ? 'animate-spin' : ''} />
            <span>{isGenerating ? 'Analyzing Archive...' : 'Generate Digest'}</span>
          </button>

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
        </div>
      </div>

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

      {/* Extracted Categories Grid */}
      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#fff', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Tag size={16} color="var(--accent-secondary)" />
          <span>Extracted Knowledge Topics ({categories.length})</span>
        </h3>
        {categories.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            No topics extracted yet. Run "Generate Digest" to automatically discover topics.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {categories.map((cat) => (
              <div 
                key={cat.id} 
                style={{
                  padding: '6px 12px',
                  borderRadius: '20px',
                  background: 'rgba(6, 182, 212, 0.12)',
                  border: '1px solid rgba(6, 182, 212, 0.3)',
                  color: '#67e8f9',
                  fontSize: '12px',
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <Tag size={12} />
                <span>{cat.name}</span>
                {cat.message_count && (
                  <span style={{ 
                    background: 'rgba(0, 0, 0, 0.3)', 
                    padding: '1px 6px', 
                    borderRadius: '10px', 
                    fontSize: '10px' 
                  }}>
                    {cat.message_count}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Global Archive Summary Card */}
      <div className="archive-card" style={{ marginBottom: '24px', borderLeft: '4px solid var(--accent-primary)' }}>
        <div className="archive-card-header">
          <span className="archive-card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BookOpen size={16} color="var(--accent-primary)" />
            Global Executive Archive Digest
          </span>
          {globalSummary && (
            <span className="archive-card-meta">
              Updated {new Date(globalSummary.created_at).toLocaleString()}
            </span>
          )}
        </div>
        <div className="archive-card-content" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.7', marginTop: '12px' }}>
          {globalSummary ? (
            globalSummary.summary_text
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>
              No global digest generated yet. Click "Generate Digest" above to analyze your archived conversations.
            </div>
          )}
        </div>
      </div>

      {/* Category / Topic Summaries */}
      <div>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: '#fff', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FileText size={16} color="var(--accent-primary)" />
          <span>Category & Topic Digests ({summaries.filter(s => s.summary_type === 'category').length})</span>
        </h3>

        {summaries.filter(s => s.summary_type === 'category').length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
            No category summaries yet.
          </div>
        ) : (
          summaries.filter(s => s.summary_type === 'category').map((sum) => (
            <div key={sum.id} className="archive-card">
              <div className="archive-card-header">
                <span className="archive-card-title">{sum.category_name || sum.title || 'Topic Summary'}</span>
                <span className="archive-card-meta">{new Date(sum.created_at).toLocaleDateString()}</span>
              </div>
              <div className="archive-card-content" style={{ whiteSpace: 'pre-wrap', marginTop: '8px' }}>
                {sum.summary_text}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
