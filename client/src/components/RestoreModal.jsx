import React, { useState, useRef } from 'react';
import { 
  X, 
  UploadCloud, 
  CheckCircle2, 
  AlertTriangle, 
  Layers, 
  RefreshCw, 
  FileText, 
  Database,
  Calendar,
  MessageSquare
} from 'lucide-react';
import { api } from '../api';

export default function RestoreModal({ isOpen, onClose, onRestored }) {
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreMode, setRestoreMode] = useState('merge'); // 'merge' | 'replace'
  const [errorMsg, setErrorMsg] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const handleReset = () => {
    setSelectedFile(null);
    setPreviewData(null);
    setErrorMsg(null);
    setSuccessMsg(null);
    setRestoreMode('merge');
  };

  const handleClose = () => {
    if (isRestoring) return;
    handleReset();
    onClose();
  };

  const handleFileProcess = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      setErrorMsg('Please select a valid .json archive backup file.');
      return;
    }

    setSelectedFile(file);
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsValidating(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const preview = await api.previewBackup(formData);
      if (!preview.valid) {
        throw new Error('This JSON file does not contain any conversations or messages.');
      }
      setPreviewData(preview);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to inspect backup file.');
      setPreviewData(null);
    } finally {
      setIsValidating(false);
    }
  };

  const handleFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFileProcess(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileProcess(file);
  };

  const handleExecuteRestore = async () => {
    if (!selectedFile) return;
    setIsRestoring(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('mode', restoreMode);

      const result = await api.restoreBackup(formData);
      setSuccessMsg(result.message || 'Archive successfully restored!');
      
      setTimeout(async () => {
        await onRestored?.(result);
        handleClose();
      }, 1200);
    } catch (err) {
      setErrorMsg(err.message || 'Failed to restore backup archive.');
    } finally {
      setIsRestoring(false);
    }
  };

  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div 
        className="modal-card" 
        style={{ width: '560px', maxWidth: '92vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Database size={18} color="var(--accent-primary)" />
            Restore JSON Archive Backup
          </h3>
          <button 
            type="button"
            onClick={handleClose}
            disabled={isRestoring}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: isRestoring ? 'not-allowed' : 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ overflowY: 'auto', flex: 1, padding: '20px 24px' }}>
          {/* File Picker Zone */}
          {!selectedFile ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${isDragging ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                borderRadius: '12px',
                padding: '36px 20px',
                textAlign: 'center',
                background: isDragging ? 'rgba(139, 92, 246, 0.08)' : 'var(--bg-tertiary)',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px'
              }}
            >
              <div style={{
                width: '48px',
                height: '48px',
                borderRadius: '12px',
                background: 'rgba(139, 92, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-primary)'
              }}>
                <UploadCloud size={24} />
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>
                  Choose a JSON Backup File
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                  Drag &amp; drop your <code>personal_ai_archive_backup.json</code> file or click to browse
                </div>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                accept=".json,application/json"
                style={{ display: 'none' }}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Selected File Details */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '10px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', overflow: 'hidden' }}>
                  <FileText size={20} color="var(--accent-primary)" style={{ flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{ fontSize: '13.5px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selectedFile.name}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                      {formatFileSize(selectedFile.size)}
                    </div>
                  </div>
                </div>
                {!isRestoring && (
                  <button
                    type="button"
                    onClick={handleReset}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '12px',
                      cursor: 'pointer',
                      padding: '4px 8px'
                    }}
                  >
                    Change File
                  </button>
                )}
              </div>

              {/* Validation Spinner */}
              {isValidating && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '13px', padding: '8px 0' }}>
                  <RefreshCw size={14} className="animate-spin" />
                  <span>Inspecting backup archive contents...</span>
                </div>
              )}

              {/* Preview Information Card */}
              {previewData && (
                <div style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '10px',
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--success)', fontSize: '13px', fontWeight: 600 }}>
                      <CheckCircle2 size={16} />
                      <span>Valid Backup Archive</span>
                    </div>
                    {previewData.exported_at && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', color: 'var(--text-muted)' }}>
                        <Calendar size={12} />
                        <span>Exported {new Date(previewData.exported_at).toLocaleDateString()}</span>
                      </div>
                    )}
                  </div>

                  {/* Stat Chips */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
                    <div style={{ background: 'var(--bg-tertiary)', padding: '8px 12px', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{previewData.counts.conversations}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Conversations</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', padding: '8px 12px', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{previewData.counts.messages}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Messages</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', padding: '8px 12px', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{previewData.counts.categories}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Topics</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', padding: '8px 12px', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{previewData.counts.summaries}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Summaries</div>
                    </div>
                  </div>

                  {/* Preview conversations snippet */}
                  {previewData.previewConversations?.length > 0 && (
                    <div style={{ marginTop: '4px' }}>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                        Sample Conversations Found:
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {previewData.previewConversations.slice(0, 3).map(c => (
                          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                            <MessageSquare size={11} color="var(--accent-primary)" />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Mode Selection */}
              {previewData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>
                    Select Restoration Strategy:
                  </div>

                  {/* Mode 1: Merge */}
                  <label style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: `1px solid ${restoreMode === 'merge' ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                    background: restoreMode === 'merge' ? 'rgba(139, 92, 246, 0.12)' : 'var(--bg-tertiary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}>
                    <input
                      type="radio"
                      name="restoreMode"
                      value="merge"
                      checked={restoreMode === 'merge'}
                      onChange={() => setRestoreMode('merge')}
                      style={{ marginTop: '3px' }}
                    />
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Layers size={14} color="var(--accent-primary)" />
                        Merge into Current Archive (Recommended)
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: '1.4' }}>
                        Safely imports new conversations and topics. Existing conversations in this instance remain untouched.
                      </div>
                    </div>
                  </label>

                  {/* Mode 2: Clean Restore (Replace) */}
                  <label style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: `1px solid ${restoreMode === 'replace' ? '#f59e0b' : 'var(--border-subtle)'}`,
                    background: restoreMode === 'replace' ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-tertiary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}>
                    <input
                      type="radio"
                      name="restoreMode"
                      value="replace"
                      checked={restoreMode === 'replace'}
                      onChange={() => setRestoreMode('replace')}
                      style={{ marginTop: '3px' }}
                    />
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <AlertTriangle size={14} color="#f59e0b" />
                        Clean Restore (Replace Current Conversations)
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: '1.4' }}>
                        Clears existing conversations and messages, establishing a clean clone matching this backup. Settings and API keys are preserved.
                      </div>
                    </div>
                  </label>

                  {restoreMode === 'replace' && (
                    <div style={{
                      padding: '8px 12px',
                      background: 'rgba(245, 158, 11, 0.15)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      borderRadius: '8px',
                      fontSize: '11.5px',
                      color: '#fcd34d',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}>
                      <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                      <span>Warning: Any conversations currently in this instance will be permanently overwritten.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Error Message */}
          {errorMsg && (
            <div style={{
              marginTop: '12px',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(239, 68, 68, 0.15)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              color: '#fca5a5',
              fontSize: '12.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <AlertTriangle size={15} style={{ flexShrink: 0 }} />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Success Message */}
          {successMsg && (
            <div style={{
              marginTop: '12px',
              padding: '10px 14px',
              borderRadius: '8px',
              background: 'rgba(16, 185, 129, 0.15)',
              border: '1px solid rgba(16, 185, 129, 0.35)',
              color: '#6ee7b7',
              fontSize: '12.5px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <CheckCircle2 size={15} style={{ flexShrink: 0 }} />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px'
        }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleClose}
            disabled={isRestoring}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleExecuteRestore}
            disabled={!previewData || isRestoring || isValidating}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              opacity: (!previewData || isRestoring || isValidating) ? 0.6 : 1
            }}
          >
            {isRestoring ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                <span>Restoring Archive...</span>
              </>
            ) : (
              <>
                <UploadCloud size={14} />
                <span>Restore Archive</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
