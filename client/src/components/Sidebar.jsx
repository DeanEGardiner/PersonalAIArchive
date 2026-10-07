import React from 'react';
import { 
  MessageSquarePlus, 
  Archive, 
  Layers, 
  Settings, 
  Trash2, 
  Bot,
  Circle,
  BookOpen
} from 'lucide-react';

export default function Sidebar({
  currentView,
  setCurrentView,
  conversations,
  activeConvId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  providerHealth,
  onOpenSettings,
  onOpenGoogleSearch
}) {
  return (
    <aside className="sidebar">
      {/* Brand Header */}
      <div className="sidebar-header">
        <div className="logo-group">
          <div className="logo-icon-wrap">
            <Bot size={20} />
          </div>
          <span className="logo-title">Personal AI Archive</span>
        </div>
        <button 
          className="nav-tab" 
          onClick={onOpenSettings}
          title="Settings & API Keys"
          style={{ padding: '6px' }}
        >
          <Settings size={18} />
        </button>
      </div>

      {/* Main View Navigation Tabs */}
      <div className="sidebar-nav">
        <button 
          className={`nav-tab ${currentView === 'chat' ? 'active' : ''}`}
          onClick={() => setCurrentView('chat')}
        >
          <MessageSquarePlus size={15} />
          <span>Chat</span>
        </button>
        <button 
          className={`nav-tab ${currentView === 'archive' ? 'active' : ''}`}
          onClick={() => setCurrentView('archive')}
        >
          <Archive size={15} />
          <span>Archive</span>
        </button>
        <button 
          className={`nav-tab ${currentView === 'summary' ? 'active' : ''}`}
          onClick={() => setCurrentView('summary')}
        >
          <Layers size={15} />
          <span>Digest</span>
        </button>
      </div>

      {/* Actions */}
      <div className="sidebar-actions" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <button className="btn-new-chat" onClick={onNewConversation}>
          <MessageSquarePlus size={16} />
          <span>New Conversation</span>
        </button>
        <button 
          className={`btn-obsidian-sidebar ${currentView === 'obsidian' ? 'active' : ''}`}
          onClick={() => setCurrentView('obsidian')}
          title="Search, browse, and sync your Obsidian Vault notes"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '9px 14px',
            borderRadius: '8px',
            background: currentView === 'obsidian' ? 'rgba(168, 85, 247, 0.22)' : 'rgba(168, 85, 247, 0.1)',
            border: `1px solid ${currentView === 'obsidian' ? 'rgba(168, 85, 247, 0.55)' : 'rgba(168, 85, 247, 0.25)'}`,
            color: '#d8b4fe',
            fontWeight: 600,
            fontSize: '13px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            boxShadow: currentView === 'obsidian' ? '0 0 12px rgba(168, 85, 247, 0.3)' : 'none'
          }}
        >
          <BookOpen size={16} color="#c084fc" />
          <span>Obsidian Notes</span>
        </button>
      </div>

      {/* Recent Conversations List */}
      <div className="conv-list">
        {conversations.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
            No conversations yet. Start one!
          </div>
        ) : (
          conversations.map((conv) => (
            <div 
              key={conv.id}
              className={`conv-item ${activeConvId === conv.id && currentView === 'chat' ? 'active' : ''}`}
              onClick={() => {
                onSelectConversation(conv.id);
                setCurrentView('chat');
              }}
            >
              <div className="conv-info">
                <div className="conv-title">{conv.title || 'Untitled Conversation'}</div>
                <div className="conv-meta">
                  <span style={{ textTransform: 'capitalize', color: 'var(--text-secondary)' }}>
                    {conv.default_provider || conv.provider || 'AI'}
                  </span>
                  { (conv.default_model || conv.model) && (
                    <>
                      <span>/</span>
                      <span style={{ maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={conv.default_model || conv.model}>
                        {conv.default_model || conv.model}
                      </span>
                    </>
                  )}
                  <span>•</span>
                  <span>{new Date(conv.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                </div>
              </div>
              <button 
                className="conv-delete-btn"
                title="Delete thread"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteConversation(conv.id);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer Provider Live Status */}
      <div className="sidebar-footer">
        <div className="health-status-row">
          <span style={{ color: 'var(--text-muted)' }}>Providers</span>
          <div className="provider-pills">
            {['gemini', 'openai', 'ollama', 'lmstudio'].map((p) => {
              const status = providerHealth?.[p];
              const isOnline = status?.available === true;
              return (
                <div key={p} className="provider-pill" title={`${p}: ${isOnline ? 'Available' : 'Offline'}`}>
                  <div className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
                  <span style={{ textTransform: 'capitalize' }}>{p === 'lmstudio' ? 'LM Studio' : p}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
