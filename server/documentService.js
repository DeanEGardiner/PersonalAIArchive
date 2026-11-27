const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const config = require('./config');

const DOCUMENTS_VAULT_SUBDIR = path.join('AI Archive', 'Documents');
const DOCUMENTS_VERSIONS_SUBDIR = path.join(DOCUMENTS_VAULT_SUBDIR, 'Versions');

class DocumentService {
  computeChecksum(content) {
    return crypto.createHash('sha256').update(content || '', 'utf8').digest('hex');
  }

  countWords(contentMd) {
    if (!contentMd || typeof contentMd !== 'string') return 0;
    const stripped = contentMd
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/[#*_~>\-\[\]()!|]/g, ' ')
      .trim();
    if (!stripped) return 0;
    return stripped.split(/\s+/).filter(Boolean).length;
  }

  sanitizeFileName(title) {
    const clean = (title || 'Untitled Document')
      .replace(/[/\\?%*:|"<>]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return clean || 'Untitled Document';
  }

  getVaultPath() {
    return config.getSetting('obsidian_vault_path') || config.getDefaultVaultPath();
  }

  isValidVaultPath(vaultPath) {
    if (!vaultPath) return false;
    try {
      return fs.existsSync(vaultPath) && fs.statSync(vaultPath).isDirectory();
    } catch (_) {
      return false;
    }
  }

  /**
   * Resolves a document's relative vault path safely inside vaultPath.
   * Defaults to AI Archive/Documents/<sanitized_title>_<id6>.md if unset.
   */
  resolveDefaultRelPath(doc) {
    if (doc.obsidian_rel_path) {
      return doc.obsidian_rel_path;
    }
    const safeTitle = this.sanitizeFileName(doc.title);
    const fileName = `${safeTitle}_${doc.id.slice(0, 6)}.md`;
    return path.join(DOCUMENTS_VAULT_SUBDIR, fileName);
  }

  safeResolveInVault(vaultPath, relPath) {
    const resolvedVault = path.resolve(vaultPath);
    const resolvedTarget = path.resolve(resolvedVault, relPath);
    if (resolvedTarget !== resolvedVault && !resolvedTarget.startsWith(resolvedVault + path.sep)) {
      throw new Error('Invalid Obsidian relative path: escapes vault directory');
    }
    return resolvedTarget;
  }

  listDocuments() {
    return db.prepare(`
      SELECT
        d.*,
        (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count
      FROM documents d
      WHERE d.is_deleted = 0
      ORDER BY d.updated_at DESC
    `).all();
  }

  getDocument(id) {
    if (!id) return null;
    return db.prepare(`
      SELECT
        d.*,
        (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count
      FROM documents d
      WHERE d.id = ? AND d.is_deleted = 0
    `).get(id) || null;
  }

  createDocument({ title = 'Untitled Document', contentMd = '', obsidianRelPath = null, createInitialVersion = true } = {}) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const cleanTitle = (title || 'Untitled Document').trim() || 'Untitled Document';
    const content = typeof contentMd === 'string' ? contentMd : '';
    const wordCount = this.countWords(content);
    const checksum = this.computeChecksum(content);
    const relPath = obsidianRelPath || path.join(DOCUMENTS_VAULT_SUBDIR, `${this.sanitizeFileName(cleanTitle)}_${id.slice(0, 6)}.md`);

    let initialVersionId = null;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO documents (id, title, content_md, obsidian_rel_path, obsidian_checksum, current_version_id, ai_highlights_json, word_count, created_at, updated_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 0)
      `).run(id, cleanTitle, content, relPath, null, wordCount, now, now);

      if (createInitialVersion) {
        initialVersionId = uuidv4();
        db.prepare(`
          INSERT INTO document_versions (id, document_id, version_number, label, content_md, checksum, author_type, created_at)
          VALUES (?, ?, 1, ?, ?, ?, 'user', ?)
        `).run(initialVersionId, id, 'Initial Draft', content, checksum, now);

        db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(initialVersionId, id);
      }
    })();

    const created = this.getDocument(id);
    // Best-effort write-through to Obsidian if vault is configured
    try {
      this.writeDocumentToVault(created);
    } catch (err) {
      console.warn(`[DocumentService] Vault write-through skipped on create: ${err.message}`);
    }

    return this.getDocument(id);
  }

  updateDocument(id, { title, contentMd, aiHighlightsJson, obsidianRelPath, syncToObsidian = false } = {}) {
    const existing = this.getDocument(id);
    if (!existing) {
      throw new Error('Document not found');
    }

    const now = new Date().toISOString();
    const nextTitle = title !== undefined ? ((title || '').trim() || 'Untitled Document') : existing.title;
    const nextContent = contentMd !== undefined ? String(contentMd) : existing.content_md;
    const nextHighlights = aiHighlightsJson !== undefined
      ? (typeof aiHighlightsJson === 'string' ? aiHighlightsJson : (aiHighlightsJson ? JSON.stringify(aiHighlightsJson) : null))
      : existing.ai_highlights_json;
    const nextRelPath = obsidianRelPath !== undefined ? obsidianRelPath : existing.obsidian_rel_path;
    const wordCount = this.countWords(nextContent);

    db.prepare(`
      UPDATE documents
      SET title = ?, content_md = ?, ai_highlights_json = ?, obsidian_rel_path = ?, word_count = ?, updated_at = ?
      WHERE id = ?
    `).run(nextTitle, nextContent, nextHighlights, nextRelPath, wordCount, now, id);

    const updated = this.getDocument(id);
    if (syncToObsidian) {
      this.writeDocumentToVault(updated);
      return this.getDocument(id);
    }
    return updated;
  }

  deleteDocument(id) {
    const existing = this.getDocument(id);
    if (!existing) {
      throw new Error('Document not found');
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE documents SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
    return { success: true, id };
  }

  saveVersion(documentId, { label = null, authorType = 'user', provider = null, model = null, promptUsed = null } = {}) {
    const doc = this.getDocument(documentId);
    if (!doc) {
      throw new Error('Document not found');
    }

    const now = new Date().toISOString();
    const checksum = this.computeChecksum(doc.content_md);
    const versionId = uuidv4();

    const maxRow = db.prepare('SELECT COALESCE(MAX(version_number), 0) AS max_ver FROM document_versions WHERE document_id = ?').get(documentId);
    const nextVer = (maxRow?.max_ver || 0) + 1;
    const cleanLabel = label && String(label).trim() ? String(label).trim() : `Version ${nextVer}`;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO document_versions (id, document_id, version_number, label, content_md, checksum, author_type, provider, model, prompt_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(versionId, documentId, nextVer, cleanLabel, doc.content_md, checksum, authorType, provider, model, promptUsed, now);

      db.prepare('UPDATE documents SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, now, documentId);
    })();

    const savedVersion = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(versionId);
    try {
      this.writeVersionToVault(doc, savedVersion);
    } catch (err) {
      console.warn(`[DocumentService] Version vault write-through skipped: ${err.message}`);
    }
    return savedVersion;
  }

  listVersions(documentId) {
    const doc = this.getDocument(documentId);
    if (!doc) {
      throw new Error('Document not found');
    }
    return db.prepare(`
      SELECT id, document_id, version_number, label, checksum, author_type, provider, model, prompt_used, created_at,
             length(content_md) AS content_length
      FROM document_versions
      WHERE document_id = ?
      ORDER BY version_number DESC
    `).all(documentId);
  }

  getVersion(documentId, versionId) {
    return db.prepare(`
      SELECT * FROM document_versions
      WHERE id = ? AND document_id = ?
    `).get(versionId, documentId) || null;
  }

  deleteVersion(documentId, versionId) {
    const doc = this.getDocument(documentId);
    if (!doc) {
      throw new Error('Document not found');
    }
    const targetVersion = this.getVersion(documentId, versionId);
    if (!targetVersion) {
      throw new Error('Version not found');
    }

    let nextCurrentId = doc.current_version_id;

    db.transaction(() => {
      db.prepare('DELETE FROM document_versions WHERE id = ? AND document_id = ?').run(versionId, documentId);
      if (doc.current_version_id === versionId) {
        const latestRemaining = db.prepare(`
          SELECT id FROM document_versions
          WHERE document_id = ?
          ORDER BY version_number DESC LIMIT 1
        `).get(documentId);
        nextCurrentId = latestRemaining?.id || null;
        db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(nextCurrentId, documentId);
      }
    })();

    try {
      const vaultPath = this.getVaultPath();
      if (this.isValidVaultPath(vaultPath)) {
        const versionPath = this.safeResolveInVault(vaultPath, this.resolveVersionRelPath(doc, targetVersion.version_number));
        if (fs.existsSync(versionPath)) {
          fs.unlinkSync(versionPath);
        }
      }
    } catch (err) {
      console.warn(`[DocumentService] Version vault cleanup skipped: ${err.message}`);
    }

    return { success: true, id: versionId, current_version_id: nextCurrentId };
  }

  restoreVersion(documentId, versionId) {
    const doc = this.getDocument(documentId);
    if (!doc) {
      throw new Error('Document not found');
    }
    const targetVersion = this.getVersion(documentId, versionId);
    if (!targetVersion) {
      throw new Error('Version not found');
    }

    // Safety snapshot of current working draft if it differs from the latest saved version
    const latestVer = db.prepare(`
      SELECT checksum FROM document_versions
      WHERE document_id = ?
      ORDER BY version_number DESC LIMIT 1
    `).get(documentId);
    const currentChecksum = this.computeChecksum(doc.content_md);
    if (!latestVer || latestVer.checksum !== currentChecksum) {
      this.saveVersion(documentId, {
        label: `Auto-backup before restoring v${targetVersion.version_number}`,
        authorType: 'auto'
      });
    }

    const now = new Date().toISOString();
    const wordCount = this.countWords(targetVersion.content_md);

    db.prepare(`
      UPDATE documents
      SET content_md = ?, current_version_id = ?, ai_highlights_json = NULL, word_count = ?, updated_at = ?
      WHERE id = ?
    `).run(targetVersion.content_md, targetVersion.id, wordCount, now, documentId);

    const restored = this.getDocument(documentId);
    try {
      this.writeDocumentToVault(restored);
    } catch (err) {
      console.warn(`[DocumentService] Vault write-through skipped on restore: ${err.message}`);
    }

    return this.getDocument(documentId);
  }

  /**
   * Writes a document's pure Markdown content to the configured Obsidian vault.
   */
  writeDocumentToVault(docOrId) {
    const doc = typeof docOrId === 'string' ? this.getDocument(docOrId) : docOrId;
    if (!doc) throw new Error('Document not found');

    const vaultPath = this.getVaultPath();
    if (!this.isValidVaultPath(vaultPath)) {
      return { synced: false, reason: 'Obsidian vault path is not configured or invalid' };
    }

    const relPath = this.resolveDefaultRelPath(doc);
    const targetPath = this.safeResolveInVault(vaultPath, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const content = doc.content_md || '';
    const checksum = this.computeChecksum(content);

    let wroteFile = false;
    if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, 'utf8') !== content) {
      fs.writeFileSync(targetPath, content, 'utf8');
      wroteFile = true;
    }

    if (doc.obsidian_rel_path !== relPath || doc.obsidian_checksum !== checksum) {
      db.prepare('UPDATE documents SET obsidian_rel_path = ?, obsidian_checksum = ? WHERE id = ?')
        .run(relPath, checksum, doc.id);
    }

    const versionSync = this.syncDocumentVersionsToVault(doc, vaultPath);

    return {
      synced: true,
      wroteFile,
      relPath,
      targetPath,
      checksum,
      versionsExported: versionSync.versionsExported || 0
    };
  }

  resolveVersionRelPath(doc, versionNumber) {
    const safeTitle = this.sanitizeFileName(doc.title);
    return path.join(DOCUMENTS_VERSIONS_SUBDIR, `${safeTitle} v${versionNumber}.md`);
  }

  writeVersionToVault(doc, version, customVaultPath = null) {
    const vaultPath = customVaultPath || this.getVaultPath();
    if (!this.isValidVaultPath(vaultPath)) {
      return { synced: false, wroteFile: false };
    }
    const relPath = this.resolveVersionRelPath(doc, version.version_number);
    const targetPath = this.safeResolveInVault(vaultPath, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const content = version.content_md || '';
    if (!fs.existsSync(targetPath) || fs.readFileSync(targetPath, 'utf8') !== content) {
      fs.writeFileSync(targetPath, content, 'utf8');
      return { synced: true, wroteFile: true, relPath, targetPath };
    }
    return { synced: true, wroteFile: false, relPath, targetPath };
  }

  syncDocumentVersionsToVault(docOrId, customVaultPath = null) {
    const doc = typeof docOrId === 'string' ? this.getDocument(docOrId) : docOrId;
    if (!doc) return { synced: false, versionsExported: 0 };

    const vaultPath = customVaultPath || this.getVaultPath();
    if (!this.isValidVaultPath(vaultPath)) {
      return { synced: false, versionsExported: 0 };
    }

    const versions = db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY version_number ASC').all(doc.id);
    let versionsExported = 0;
    for (const ver of versions) {
      const res = this.writeVersionToVault(doc, ver, vaultPath);
      if (res.wroteFile) versionsExported++;
    }
    return { synced: true, versionsExported };
  }
}

module.exports = new DocumentService();

