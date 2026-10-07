import React, { useState, useEffect } from 'react';
import { X, Key, Server, Check, FolderSync } from 'lucide-react';
import { api } from '../api';

export default function SettingsModal({ isOpen, onClose, onSaved }) {
  const [geminiKey, setGeminiKey] = useState('');
  const [openAiKey, setOpenAiKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [lmStudioUrl, setLmStudioUrl] = useState('http://localhost:1234/v1');
  const [obsidianVaultPath, setObsidianVaultPath] = useState('/Users/deangardiner/Documents/DeanGVault');
  const [obsidianStatus, setObsidianStatus] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

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
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  };

  const checkVaultPath = async (val) => {
    try {
      const updated = await api.updateObsidianVaultPath(val);
      setObsidianStatus(updated);
    } catch (_) {}
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await api.updateSettings({
        gemini_api_key: geminiKey,
        openai_api_key: openAiKey,
        ollama_base_url: ollamaUrl,
        lmstudio_base_url: lmStudioUrl
      });
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
                checkVaultPath(e.target.value);
              }}
            />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Absolute path to your local Obsidian vault. Sync will create an <code>AI Archive</code> folder inside this vault.
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
    </div>
  );
}
