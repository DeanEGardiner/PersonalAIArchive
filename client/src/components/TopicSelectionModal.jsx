import React, { useState, useMemo } from 'react';
import { X, Search, Tag, Check, CheckSquare, Square, FileText, Sparkles } from 'lucide-react';

export default function TopicSelectionModal({ 
  isOpen, 
  onClose, 
  categories = [], 
  selectedCategoryIds = [], 
  onSelectionChange 
}) {
  const [searchQuery, setSearchQuery] = useState('');

  // Filter categories by search (must be called unconditionally before early returns)
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return categories;
    const q = searchQuery.toLowerCase();
    return categories.filter(c => 
      c.name.toLowerCase().includes(q) || 
      (c.description && c.description.toLowerCase().includes(q)) ||
      (c.latest_summary && c.latest_summary.toLowerCase().includes(q))
    );
  }, [categories, searchQuery]);

  if (!isOpen) return null;

  const toggleCategory = (id) => {
    if (selectedCategoryIds.includes(id)) {
      onSelectionChange(selectedCategoryIds.filter(item => item !== id));
    } else {
      onSelectionChange([...selectedCategoryIds, id]);
    }
  };

  const handleSelectAll = () => {
    const allIds = categories.map(c => c.id);
    onSelectionChange(allIds);
  };

  const handleClearAll = () => {
    onSelectionChange([]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div 
        className="modal-card" 
        style={{ width: '640px', maxWidth: '94vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
              <Tag size={18} color="var(--accent-primary)" />
              <span>Select Knowledge Topics for Memory</span>
            </h3>
            <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
              Choose specific archived topics to inject into the AI context for targeted retrieval.
            </p>
          </div>
          <button 
            className="icon-btn" 
            onClick={onClose}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Search & Actions Bar */}
        <div style={{ 
          padding: '12px 20px', 
          borderBottom: '1px solid var(--border-subtle)', 
          background: 'var(--bg-tertiary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          flexWrap: 'wrap'
        }}>
          {/* Search Input */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '8px',
            padding: '6px 12px',
            flex: '1',
            minWidth: '200px'
          }}>
            <Search size={14} color="var(--text-muted)" />
            <input 
              type="text"
              placeholder="Filter topics..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#fff',
                fontSize: '13px',
                outline: 'none',
                width: '100%'
              }}
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Quick Selection Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: '4px' }}>
              <strong style={{ color: 'var(--accent-primary)' }}>{selectedCategoryIds.length}</strong> of {categories.length} selected
            </span>
            <button 
              className="btn-secondary"
              onClick={handleSelectAll}
              style={{ padding: '5px 10px', fontSize: '11px' }}
            >
              Select All
            </button>
            <button 
              className="btn-secondary"
              onClick={handleClearAll}
              style={{ padding: '5px 10px', fontSize: '11px' }}
            >
              Clear
            </button>
          </div>
        </div>

        {/* Scrollable Topics List */}
        <div style={{ 
          padding: '16px 20px', 
          overflowY: 'auto', 
          flex: '1', 
          display: 'flex', 
          flexDirection: 'column', 
          gap: '10px' 
        }}>
          {categories.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
              <Tag size={32} style={{ opacity: 0.3, marginBottom: '12px' }} />
              <p style={{ margin: 0, fontSize: '14px' }}>No knowledge topics found in the archive yet.</p>
              <p style={{ margin: '6px 0 0', fontSize: '12px' }}>
                Run "Generate Digest" in the Archive Digest view to automatically extract topics.
              </p>
            </div>
          ) : filteredCategories.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--text-muted)', fontSize: '13px' }}>
              No topics matching "{searchQuery}".
            </div>
          ) : (
            filteredCategories.map((cat) => {
              const isSelected = selectedCategoryIds.includes(cat.id);
              return (
                <div
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    border: isSelected 
                      ? '1px solid var(--accent-primary)' 
                      : '1px solid var(--border-subtle)',
                    background: isSelected 
                      ? 'rgba(139, 92, 246, 0.12)' 
                      : 'var(--bg-secondary)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '12px',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-subtle)';
                  }}
                >
                  <div style={{ marginTop: '2px', color: isSelected ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                    {isSelected ? <CheckSquare size={18} /> : <Square size={18} />}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ 
                        fontWeight: 600, 
                        fontSize: '13px', 
                        color: isSelected ? '#fff' : 'var(--text-primary)' 
                      }}>
                        {cat.name}
                      </span>
                      {cat.last_updated && (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {new Date(cat.last_updated).toLocaleDateString()}
                        </span>
                      )}
                    </div>

                    {cat.description && (
                      <p style={{ 
                        margin: '4px 0 0', 
                        fontSize: '12px', 
                        color: 'var(--text-secondary)', 
                        lineHeight: '1.4' 
                      }}>
                        {cat.description}
                      </p>
                    )}

                    {cat.latest_summary && (
                      <p style={{ 
                        margin: '6px 0 0', 
                        fontSize: '11px', 
                        color: 'var(--text-muted)', 
                        lineHeight: '1.4',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical'
                      }}>
                        {cat.latest_summary}
                      </p>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div style={{ 
          padding: '14px 20px', 
          borderTop: '1px solid var(--border-subtle)', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          background: 'var(--bg-secondary)'
        }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {selectedCategoryIds.length === 0 
              ? 'No topics selected (will fall back to latest summaries)' 
              : `${selectedCategoryIds.length} topic${selectedCategoryIds.length === 1 ? '' : 's'} active for retrieval`}
          </span>
          <button 
            className="btn-primary" 
            onClick={onClose}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 18px' }}
          >
            <Check size={15} />
            <span>Done ({selectedCategoryIds.length})</span>
          </button>
        </div>
      </div>
    </div>
  );
}
