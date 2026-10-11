/**
 * Central configuration: model defaults, settings access, API key and
 * provider URL resolution. Every other module should go through here
 * instead of querying the settings table or process.env directly.
 */
const { db } = require('./db');

const PROVIDERS = ['gemini', 'openai', 'ollama', 'lmstudio'];
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio']);

const DEFAULT_MODELS = {
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-4o-mini',
  ollama: 'gemma4:12b-mlx',
  lmstudio: 'qwen/qwen3.8-27b'
};

// Shown when a provider can't be probed for its live model list
const FALLBACK_MODEL_LISTS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'o3-mini', 'gpt-4-turbo'],
  ollama: [],
  lmstudio: []
};

const DEFAULT_PROVIDER = 'gemini';
const DEFAULT_URLS = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1'
};

// Keys whose values must never be returned to the browser in full
const SECRET_KEYS = new Set(['gemini_api_key', 'openai_api_key']);

// History & context limits for AI posts
const HISTORY_TURNS = 12;
const HISTORY_MESSAGE_CHARS = 4000;

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const allStmt = db.prepare('SELECT key, value FROM settings');
const upsertStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
`);
const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');

function getSetting(key, fallback = null) {
  const row = getStmt.get(key);
  return row?.value ?? fallback;
}

function setSetting(key, value) {
  upsertStmt.run(key, String(value));
}

function deleteSetting(key) {
  deleteStmt.run(key);
}

function getAllSettings() {
  const out = {};
  for (const r of allStmt.all()) out[r.key] = r.value;
  return out;
}

function maskSecret(value) {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `••••${value.slice(-4)}`;
}

/** Settings safe to send to the client (secrets masked). */
function getPublicSettings() {
  const raw = getAllSettings();
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = maskSecret(v);
      out[`${k}_set`] = !!v;
    } else {
      out[k] = v;
    }
  }
  for (const k of SECRET_KEYS) {
    if (!(k in out)) {
      out[k] = '';
      out[`${k}_set`] = false;
    }
  }
  return out;
}

function getApiKey(provider) {
  if (provider === 'gemini') return getSetting('gemini_api_key') || process.env.GEMINI_API_KEY || null;
  if (provider === 'openai') return getSetting('openai_api_key') || process.env.OPENAI_API_KEY || null;
  return null;
}

function getOllamaUrl() {
  return (getSetting('ollama_base_url') || process.env.OLLAMA_BASE_URL || DEFAULT_URLS.ollama).trim().replace(/\/+$/, '');
}

function getLMStudioUrl() {
  let url = (getSetting('lmstudio_base_url') || process.env.LMSTUDIO_BASE_URL || DEFAULT_URLS.lmstudio).trim().replace(/\/+$/, '');
  if (!url.endsWith('/v1')) url += '/v1';
  return url;
}

function resolveModel(provider, model) {
  return model || DEFAULT_MODELS[provider] || DEFAULT_MODELS[DEFAULT_PROVIDER];
}

function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.has(provider);
}

function getDefaultVaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

module.exports = {
  PROVIDERS,
  DEFAULT_MODELS,
  FALLBACK_MODEL_LISTS,
  DEFAULT_PROVIDER,
  SECRET_KEYS,
  HISTORY_TURNS,
  HISTORY_MESSAGE_CHARS,
  getSetting,
  setSetting,
  deleteSetting,
  getAllSettings,
  maskSecret,
  getPublicSettings,
  getApiKey,
  getOllamaUrl,
  getLMStudioUrl,
  resolveModel,
  isLocalProvider,
  getDefaultVaultPath
};
