import React, { useState, useEffect, useRef } from 'react';
import { X, Key, Server, Check, FolderSync, Database, Download, Upload, Cpu, Sparkles } from 'lucide-react';
import { api } from '../api';
import RestoreModal from './RestoreModal';

export default function SettingsModal({ isOpen, onClose, onSaved, onRestoreComplete }) {
  const [geminiKey, setGeminiKey] = useState('');
  const [openAiKey, setOpenAiKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [lmStudioUrl, setLmStudioUrl] = useState('http://localhost:1234/v1');
  const [obsidianVaultPath, setObsidianVaultPath] = useState('/Users/deangardiner/Documents/DeanGVault');
  const [obsidianStatus, setObsidianStatus] = useState(null);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [isRestoreOpen, setIsRestoreOpen] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const loadSettings = async () => {
    try {
      const s = await api.getSettings();
      if (s.gemini_api_key) setGeminiKey(s.gemini_api_key);
      if (s.openai_api_key) setOpenAiKey(s.openai_api_key);
      if (s.ollama_base_url) setOllamaUrl(s.ollama_base_url);
      if (s.lmstudio_base_url) setLmStudioUrl(s.lmstudio_base_url);
      if (s.obsidian_vault_path) setObsidianVaultPath(s.obsidian_vault_path);

      const obsStatus = await api.getObsidianStatus().catch(() => null);
      if (obsStatus) {
        setObsidianStatus(obsStatus);
        if (obsStatus.vaultPath) setObsidianVaultPath(obsStatus.vaultPath);
      }

      const embStatus = await api.getEmbeddingStatus().catch(() => null);
      if (embStatus) {
        setEmbeddingStatus(embStatus);
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  };

  const checkVaultTimerRef = useRef(null);

  const triggerVaultCheck = (val) => {
    if (checkVaultTimerRef.current) clearTimeout(checkVaultTimerRef.current);
    checkVaultTimerRef.current = setTimeout(async () => {
      try {
        const updated = await api.updateObsidianVaultPath(val);
        setObsidianStatus(updated);
      } catch (_) {}
    }, 600);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const payload = {
        ollama_base_url: ollamaUrl,
        lmstudio_base_url: lmStudioUrl
      };
      if (geminiKey && !geminiKey.startsWith('••••')) {
        payload.gemini_api_key = geminiKey;
      }
      if (openAiKey && !openAiKey.startsWith('••••')) {
        payload.openai_api_key = openAiKey;
      }
      await api.updateSettings(payload);
      await api.updateObsidianVaultPath(obsidianVaultPath);
      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        onSaved?.();
        onClose();
      }, 700);
    } catch (err) {
      alert('Failed to save settings: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleBackfillEmbeddings = async () => {
    setIsIndexing(true);
    try {
      const res = await api.triggerEmbeddingBackfill();
      if (res?.status) setEmbeddingStatus(res.status);
    } catch (err) {
      alert('Failed to trigger embedding indexing: ' + err.message);
    } finally {
      setIsIndexing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Key size={18} color="var(--accent-primary)" />
            Settings & Provider Endpoints
          </h3>
          <button 
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Google Gemini API Key</label>
            <input 
              type="password"
              className="form-input"
              placeholder="AIzaSy..."
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
            />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Saved securely in local SQLite database. Falls back to GEMINI_API_KEY in .env.
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">OpenAI API Key</label>
            <input 
              type="password"
              className="form-input"
              placeholder="sk-proj-..."
              value={openAiKey}
              onChange={(e) => setOpenAiKey(e.target.value)}
            />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Falls back to OPENAI_API_KEY in .env.
            </span>
          </div>

          <div className="form-group">
            <label className="form-label">Ollama Local Endpoint</label>
            <input 
              type="text"
              className="form-input"
              placeholder="http://localhost:11434"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">LM Studio Local Endpoint</label>
            <input 
              type="text"
              className="form-input"
              placeholder="http://localhost:1234"
              value={lmStudioUrl}
              onChange={(e) => setLmStudioUrl(e.target.value)}
            />
          </div>

          <div style={{ height: '1px', background: 'var(--border-subtle)', margin: '18px 0' }} />

          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label className="form-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <FolderSync size={15} color="var(--accent-primary)" />
                <span>Obsidian Vault Root Directory</span>
              </label>
              {obsidianStatus && (
                <span style={{ 
                  fontSize: '11px', 
                  padding: '2px 8px', 
                  borderRadius: '12px',
                  fontWeight: 500,
                  background: obsidianStatus.isValid ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: obsidianStatus.isValid ? 'var(--success)' : 'var(--error)',
                  border: `1px solid ${obsidianStatus.isValid ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
                }}>
                  {obsidianStatus.isValid ? `✓ Vault Valid (${obsidianStatus.diskNoteCount} notes)` : '⚠️ Path Not Found'}
                </span>
              )}
            </div>
            <input 
              type="text"
              className="form-input"
              placeholder="/Users/deangardiner/Documents/DeanGVault"
              value={obsidianVaultPath}
              onChange={(e) => {
                setObsidianVaultPath(e.target.value);
                triggerVaultCheck(e.target.value);
              }}
              onBlur={() => triggerVaultCheck(obsidianVaultPath)}
            />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Absolute path to your local Obsidian vault. Sync will create an <code>AI Archive</code> folder inside this vault.
            </span>
          </div>

          {/* Local Hybrid Search & Vector Embeddings */}
          <div className="form-group" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Cpu size={15} color="var(--accent-primary)" />
                <span>Local Hybrid Search &amp; Vector Embeddings</span>
              </div>
              {embeddingStatus && (
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '4px', background: 'var(--bg-card)', color: 'var(--accent-primary)', border: '1px solid var(--border-subtle)' }}>
                  {embeddingStatus.config?.model}
                </span>
              )}
            </label>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                <div>Indexed Messages: <strong>{embeddingStatus?.embeddedMessages ?? 0} / {embeddingStatus?.totalMessages ?? 0}</strong></div>
                <div>Indexed Digests: <strong>{embeddingStatus?.embeddedSummaries ?? 0} / {embeddingStatus?.totalSummaries ?? 0}</strong></div>
                <div>Indexed Obsidian Notes: <strong>{embeddingStatus?.embeddedObsidianNotes ?? 0} / {embeddingStatus?.totalObsidianNotes ?? 0}</strong></div>
              </div>
              <button
                type="button"
                onClick={handleBackfillEmbeddings}
                disabled={isIndexing}
                className="btn-secondary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '7px 12px', cursor: 'pointer' }}
                title="Generate vector embeddings for all past conversations and summaries using your local model"
              >
                <Sparkles size={13} color="var(--accent-primary)" />
                <span>{isIndexing ? 'Indexing...' : 'Index Archive Embeddings'}</span>
              </button>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Enables dense semantic search + FTS5 keyword matching via Reciprocal Rank Fusion (RRF). 100% private and local.
            </span>
          </div>

          {/* Data Portability & Backup */}
          <div className="form-group" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Database size={15} color="var(--accent-primary)" />
              <span>Database Backup &amp; Data Portability</span>
            </label>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
              <a
                href="/api/export/json"
                download
                className="btn-secondary"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '7px 12px' }}
                title="Download full JSON snapshot of conversations, messages, and topics"
              >
                <Download size={13} />
                <span>Download JSON Backup</span>
              </a>
              <button
                type="button"
                onClick={() => setIsRestoreOpen(true)}
                className="btn-secondary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', padding: '7px 12px', cursor: 'pointer' }}
                title="Restore a JSON backup into this instance"
              >
                <Upload size={13} />
                <span>Restore JSON Backup</span>
              </button>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Export or restore entire conversational history across instances with full SQLite FTS5 re-indexing.
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button 
            className="btn-primary" 
            onClick={handleSave}
            disabled={isSaving}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {savedSuccess ? (
              <>
                <Check size={14} />
                <span>Saved!</span>
              </>
            ) : (
              <span>Save Changes</span>
            )}
          </button>
        </div>
      </div>

      {/* Restore JSON Backup Modal */}
      <RestoreModal
        isOpen={isRestoreOpen}
        onClose={() => setIsRestoreOpen(false)}
        onRestored={async (res) => {
          await onRestoreComplete?.(res);
          onSaved?.();
        }}
      />
    </div>
  );
}
