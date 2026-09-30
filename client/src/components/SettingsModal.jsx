import React, { useState, useEffect } from 'react';
import { X, Key, Server, Check } from 'lucide-react';
import { api } from '../api';

export default function SettingsModal({ isOpen, onClose, onSaved }) {
  const [geminiKey, setGeminiKey] = useState('');
  const [openAiKey, setOpenAiKey] = useState('');
  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [lmStudioUrl, setLmStudioUrl] = useState('http://localhost:1234/v1');
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
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
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
