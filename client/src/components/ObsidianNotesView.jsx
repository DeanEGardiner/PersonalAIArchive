import React, { useState, useEffect, useRef } from 'react';
import { 
  BookOpen, 
  Search, 
  RefreshCw, 
  FileText, 
  Calendar, 
  Clock, 
  Folder, 
  ArrowRight, 
  CheckCircle2,
  MessageSquarePlus,
  Send,
  X
} from 'lucide-react';
import { api } from '../api';
import FormattedText from './FormattedText';

export default function ObsidianNotesView({
  initialSelectedNoteId,
  initialSearchQuery = '',
  onClearInitialNote,
  onInsertIntoComposer,
  onStartChatWithNote
}) {
  const [notes, setNotes] = useState([]);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');
  const [status, setStatus] = useState(null);
  const [selectedNote, setSelectedNote] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncToast, setSyncToast] = useState(null);

  const searchTimerRef = useRef(null);
  const lastHandledRef = useRef(null);

  const loadData = async (query = '', targetNoteId = null) => {
    setIsLoading(true);
    try {
      const idToFetch = targetNoteId || initialSelectedNoteId;
      const [statusRes, notesRes, directNote] = await Promise.all([
        api.getObsidianStatus().catch(() => null),
        api.getObsidianNotes(query).catch(() => []),
        idToFetch ? api.getObsidianNoteById(idToFetch).catch(() => null) : Promise.resolve(null)
      ]);
      setStatus(statusRes);

      let finalNotes = notesRes || [];
      if (directNote && !finalNotes.some(n => n.id === directNote.id)) {
        finalNotes = [directNote, ...finalNotes];
      }
      setNotes(finalNotes);

      // Determine selected note
      let chosen = directNote;
      if (!chosen && idToFetch && finalNotes.length > 0) {
        const cleanId = String(idToFetch).replace(/^note:/, '').toLowerCase();
        chosen = finalNotes.find(n => 
          n.id === cleanId || 
          n.id === idToFetch || 
          n.rel_path === idToFetch || 
          n.file_name === idToFetch ||
          (n.title && n.title.toLowerCase() === cleanId)
        );
      }

      if (!chosen && finalNotes.length > 0) {
        chosen = (!selectedNote || !finalNotes.some(n => n.id === selectedNote.id)) ? finalNotes[0] : selectedNote;
      }

      if (chosen) {
        setSelectedNote(chosen);
        if (!chosen.content) {
          api.getObsidianNoteById(chosen.id).then(full => {
            if (full && full.content) {
              setSelectedNote(full);
              setNotes(prev => prev.map(item => item.id === full.id ? full : item));
            }
          }).catch(() => {});
        }
      } else {
        setSelectedNote(null);
      }
    } catch (err) {
      console.error('Failed to load Obsidian notes:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Trigger when a note navigation request arrives
  useEffect(() => {
    if (initialSelectedNoteId) {
      if (lastHandledRef.current === initialSelectedNoteId) return;
      lastHandledRef.current = initialSelectedNoteId;
      const q = initialSearchQuery || '';
      setSearchQuery(q);
      loadData(q, initialSelectedNoteId);
      if (onClearInitialNote) {
        onClearInitialNote();
      }
    }
  }, [initialSelectedNoteId, initialSearchQuery]);

  // Initial load if no specific note was requested on mount
  useEffect(() => {
    if (!initialSelectedNoteId) {
      loadData('');
    }
  }, []);

  const executeSearch = async (q) => {
    setIsSearching(true);
    try {
      const notesRes = await api.getObsidianNotes(q);
      setNotes(notesRes || []);
      if (notesRes && notesRes.length > 0) {
        if (!selectedNote || !notesRes.some(n => n.id === selectedNote.id)) {
          const target = notesRes[0];
          setSelectedNote(target);
          if (!target.content) {
            api.getObsidianNoteById(target.id).then(full => {
              if (full && full.content) {
                setSelectedNote(full);
                setNotes(prev => prev.map(item => item.id === full.id ? full : item));
              }
            }).catch(() => {});
          }
        }
      } else {
        setSelectedNote(null);
      }
    } catch (err) {
      console.error('Search notes failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = (e) => {
    const q = e.target.value;
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      executeSearch(q);
    }, 180);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    executeSearch('');
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncToast(null);
    try {
      const res = await api.syncObsidian();
      await loadData(searchQuery);
      setSyncToast({
        type: 'success',
        msg: `Synced successfully in ${res.durationMs}ms! Imported ${res.importedCount} new, updated ${res.updatedCount}, exported ${res.exportedCount} conversations to AI Archive.`
      });
      setTimeout(() => setSyncToast(null), 6000);
    } catch (err) {
      setSyncToast({
        type: 'error',
        msg: `Sync failed: ${err.message}`
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSelectNote = async (n) => {
    if (!n) return;
    if (n.content) {
      setSelectedNote(n);
      return;
    }
    setSelectedNote(n);
    try {
      const fullNote = await api.getObsidianNoteById(n.id);
      if (fullNote && fullNote.content) {
        setSelectedNote(fullNote);
        setNotes((prev) => prev.map((item) => (item.id === n.id ? { ...item, content: fullNote.content } : item)));
      }
    } catch (_) {}
  };

  return (
    <div className="obsidian-notes-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="view-header" style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 4px 0' }}>
            <div style={{ padding: '6px', borderRadius: '8px', background: 'rgba(168, 85, 247, 0.15)', border: '1px solid rgba(168, 85, 247, 0.3)', display: 'flex' }}>
              <BookOpen size={20} color="#c084fc" />
            </div>
            <span>Obsidian Vault Explorer</span>
          </h2>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
            {status?.vaultPath ? (
              <span>Vault: <code style={{ color: '#d8b4fe', background: 'rgba(168, 85, 247, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>{status.vaultPath}</code> ({notes.length} notes synced)</span>
            ) : (
              'Connect and search through your local Obsidian notes'
            )}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {status?.lastSync && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={12} />
              <span>Last synced: {new Date(status.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          )}
          <button 
            className="btn-primary" 
            onClick={handleSync}
            disabled={isSyncing}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '8px', 
              background: 'linear-gradient(135deg, #a855f7 0%, #7c3aed 100%)',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '8px',
              fontWeight: 600,
              fontSize: '13px',
              cursor: isSyncing ? 'not-allowed' : 'pointer'
            }}
          >
            <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
            <span>{isSyncing ? 'Syncing Vault...' : 'Sync Obsidian Vault'}</span>
          </button>
        </div>
      </div>

      {/* Sync Toast Feedback */}
      {syncToast && (
        <div style={{
          padding: '10px 16px',
          margin: '12px 24px 0 24px',
          borderRadius: '8px',
          fontSize: '12px',
          fontWeight: 500,
          background: syncToast.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
          border: `1px solid ${syncToast.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
          color: syncToast.type === 'success' ? 'var(--success)' : 'var(--error)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <CheckCircle2 size={14} />
          <span>{syncToast.msg}</span>
        </div>
      )}

      {/* Main Content: Split Pane */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left List Pane */}
        <div style={{ width: '380px', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
          {/* Search Box */}
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '8px 12px' }}>
              {isSearching ? (
                <RefreshCw size={16} className="animate-spin" color="var(--accent-primary)" />
              ) : (
                <Search size={16} color="var(--text-muted)" />
              )}
              <input 
                type="text"
                placeholder="Search notes, tags, or content..."
                value={searchQuery}
                onChange={handleSearch}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                    executeSearch(searchQuery);
                  }
                }}
                style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '13px', outline: 'none', width: '100%' }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  title="Clear search"
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '2px' }}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            {searchQuery && (
              <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Found <strong>{notes.length}</strong> matching notes</span>
                <span style={{ color: 'var(--accent-primary)', cursor: 'pointer' }} onClick={handleClearSearch}>Clear</span>
              </div>
            )}
          </div>

          {/* Notes List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px' }}>
            {isLoading ? (
              <div style={{ padding: '30px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                <RefreshCw size={18} className="animate-spin" style={{ margin: '0 auto 8px auto', display: 'block' }} />
                Loading notes...
              </div>
            ) : notes.length === 0 ? (
              <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                <BookOpen size={24} style={{ margin: '0 auto 10px auto', display: 'block', opacity: 0.5 }} />
                {searchQuery ? 'No matching notes found.' : 'No notes synced yet. Click "Sync Obsidian Vault" to import.'}
              </div>
            ) : (
              notes.map((note) => {
                const isSelected = selectedNote?.id === note.id;
                return (
                  <div
                    key={note.id}
                    onClick={() => handleSelectNote(note)}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      marginBottom: '6px',
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(168, 85, 247, 0.15)' : 'var(--bg-secondary)',
                      border: `1px solid ${isSelected ? 'rgba(168, 85, 247, 0.45)' : 'transparent'}`,
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 600, fontSize: '13px', color: isSelected ? '#d8b4fe' : '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '240px' }}>
                        {note.title}
                      </span>
                    </div>

                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '4px', marginBottom: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
                        <Folder size={11} color="var(--accent-primary)" />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note.rel_path}</span>
                      </div>
                      {note.created_at && (
                        <span style={{ flexShrink: 0, fontSize: '11px', color: 'var(--text-muted)' }}>
                          {new Date(note.created_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineClamp: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: '1.4' }}>
                      {note.preview || 'No text preview available.'}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Reader / Detail Pane */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
          {selectedNote ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
              {/* Note Header */}
              <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
                <div style={{ overflow: 'hidden' }}>
                  <h3 style={{ fontSize: '17px', fontWeight: 600, color: '#fff', margin: '0 0 4px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedNote.title}
                  </h3>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>Path: <code>{selectedNote.rel_path}</code></span>
                    {selectedNote.created_at && (
                      <span>· Created {new Date(selectedNote.created_at).toLocaleDateString()}</span>
                    )}
                    {selectedNote.updated_at && (
                      <span>· Synced {new Date(selectedNote.updated_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                  {onInsertIntoComposer && (
                    <button
                      className="btn-secondary"
                      onClick={() => onInsertIntoComposer(selectedNote.content || selectedNote.preview)}
                      title="Insert this note's text into the active chat composer"
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
                    >
                      <Send size={13} color="var(--accent-primary)" />
                      <span>Insert into Chat</span>
                    </button>
                  )}
                  {onStartChatWithNote && (
                    <button
                      className="btn-primary"
                      onClick={() => onStartChatWithNote(selectedNote)}
                      title="Start a new chat analyzing this specific Obsidian note"
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 12px' }}
                    >
                      <MessageSquarePlus size={13} />
                      <span>Ask AI About Note</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Note Body */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
                <div className="message-bubble assistant" style={{ background: 'transparent', border: 'none', padding: 0, maxWidth: '100%' }}>
                  <FormattedText text={selectedNote.content || selectedNote.preview || '*Empty note*'} />
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: '12px' }}>
              <BookOpen size={36} color="var(--border-subtle)" />
              <p style={{ fontSize: '14px' }}>Select an Obsidian note on the left to read its content</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
