import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Markdown } from 'tiptap-markdown';
import { diffWords } from 'diff';
import {
  FileText,
  Plus,
  Trash2,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  FileCode,
  Link as LinkIcon,
  Table as TableIcon,
  Undo2,
  Redo2,
  RefreshCw,
  BookmarkPlus,
  Eye,
  Code2,
  CheckCircle2,
  Sparkles,
  Check,
  History,
  Search,
  Copy,
  CornerDownLeft,
  RotateCcw,
  Wand2,
  MessageSquare,
  BookOpen,
  X,
  PanelRightOpen,
  PanelRightClose,
  Square
} from 'lucide-react';
import { api } from '../api';
import AIChangeMark from '../extensions/AIChangeMark';

function stripOuterCodeFences(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1] : text;
}

/**
 * Wraps AI-added segments in <span data-ai-change="true"> while keeping
 * Markdown block prefixes (#, -, *, >, 1.) outside the inline span so
 * tiptap-markdown parses headings/lists/quotes cleanly.
 */
function buildHighlightedMarkdown(beforeMd, afterMd, provider, model) {
  const parts = diffWords(beforeMd || '', afterMd || '');
  const changeId = `ai-${Date.now()}`;
  const attrs = `data-ai-change="true" data-change-id="${changeId}" data-ai-provider="${provider || ''}" data-ai-model="${model || ''}"`;

  return parts
    .filter((p) => !p.removed)
    .map((part) => {
      if (!part.added) return part.value;
      // Split by newlines so spans never cross block boundaries
      return part.value
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          const prefixMatch = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|>\s+))(.*)$/);
          if (prefixMatch) {
            const [, prefix, rest] = prefixMatch;
            return rest.trim() ? `${prefix}<span class="ai-change-highlight" ${attrs}>${rest}</span>` : line;
          }
          return `<span class="ai-change-highlight" ${attrs}>${line}</span>`;
        })
        .join('\n');
    })
    .join('');
}

export default function DocumentWriterView({
  initialDocumentId = null,
  onClearInitialDocument,
  writerSeedPayload = null,
  onClearWriterSeed,
  providerHealth = null,
  defaultProvider = 'gemini',
  defaultModel = ''
}) {
  const [documents, setDocuments] = useState([]);
  const [activeDoc, setActiveDoc] = useState(null);
  const [title, setTitle] = useState('');
  const [rawMarkdown, setRawMarkdown] = useState('');
  const [isRawMode, setIsRawMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [syncMessage, setSyncMessage] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasAIChanges, setHasAIChanges] = useState(false);
  const [preAiMarkdown, setPreAiMarkdown] = useState(null);

  // Left Rail: 'docs' | 'sources'
  const [leftTab, setLeftTab] = useState('docs');
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceResults, setSourceResults] = useState([]);
  const [isSearchingSources, setIsSearchingSources] = useState(false);

  // Right Utility Drawer: 'ai' | 'versions'
  const [isRightOpen, setIsRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState('ai');

  // AI Assistant state
  const [aiProvider, setAiProvider] = useState(defaultProvider || 'gemini');
  const [aiModel, setAiModel] = useState(defaultModel || '');
  const [aiAction, setAiAction] = useState('edit'); // 'edit' | 'refine' | 'review' | 'update'
  const [aiScope, setAiScope] = useState('document'); // 'document' | 'selection'
  const [aiInstruction, setAiInstruction] = useState('');
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiStreamOutput, setAiStreamOutput] = useState('');
  const [aiReviewResult, setAiReviewResult] = useState('');
  const aiAbortRef = useRef(null);

  // Version History state
  const [versions, setVersions] = useState([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [showSaveVersionBox, setShowSaveVersionBox] = useState(false);
  const [versionLabel, setVersionLabel] = useState('');
  const [isSavingVersion, setIsSavingVersion] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(null);

  const saveTimerRef = useRef(null);
  const activeDocIdRef = useRef(null);
  const isHydratingRef = useRef(false);
  const titleRef = useRef(title);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // Sync available model when provider changes
  useEffect(() => {
    if (!providerHealth) return;
    const provInfo = providerHealth[aiProvider];
    if (provInfo?.models?.length > 0 && !provInfo.models.includes(aiModel)) {
      setAiModel(provInfo.models[0]);
    }
  }, [aiProvider, providerHealth, aiModel]);

  const checkHasAIChanges = useCallback((ed) => {
    if (!ed) return false;
    let found = false;
    ed.state.doc.descendants((node) => {
      if (found) return false;
      if (node.marks?.some((m) => m.type.name === 'aiChange')) {
        found = true;
        return false;
      }
      return true;
    });
    return found;
  }, []);

  const persistDocument = useCallback(async (docId, nextTitle, nextMd, nextHighlights = undefined) => {
    if (!docId) return;
    setSaveStatus('saving');
    try {
      const updated = await api.updateDocument(docId, {
        title: nextTitle,
        contentMd: nextMd,
        aiHighlightsJson: nextHighlights
      });
      setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
      if (activeDocIdRef.current === updated.id) {
        setActiveDoc((prev) => (prev ? { ...prev, ...updated } : updated));
      }
      setSaveStatus('saved');
    } catch (err) {
      console.error('Failed to auto-save document:', err);
      setSaveStatus('unsaved');
    }
  }, []);

  const scheduleAutoSave = useCallback((docId, nextTitle, nextMd) => {
    if (!docId || isHydratingRef.current) return;
    setSaveStatus('unsaved');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistDocument(docId, nextTitle, nextMd);
    }, 800);
  }, [persistDocument]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank'
        }
      }),
      Placeholder.configure({
        placeholder: 'Start writing your document, or paste content from conversations & notes...'
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        html: true,
        tightLists: true,
        transformPastedText: true,
        transformCopiedText: true
      }),
      AIChangeMark
    ],
    content: '',
    editorProps: {
      attributes: {
        class: 'writer-prose-editor'
      }
    },
    onUpdate: ({ editor: ed }) => {
      if (isHydratingRef.current) return;
      const md = ed.storage.markdown.getMarkdown();
      setRawMarkdown(md);
      setHasAIChanges(checkHasAIChanges(ed));
      if (activeDocIdRef.current) {
        scheduleAutoSave(activeDocIdRef.current, titleRef.current, md);
      }
    }
  });

  const loadVersions = useCallback(async (docId) => {
    if (!docId) return;
    setIsLoadingVersions(true);
    try {
      const list = await api.getDocumentVersions(docId);
      setVersions(list);
    } catch (err) {
      console.error('Failed to load versions:', err);
    } finally {
      setIsLoadingVersions(false);
    }
  }, []);

  const loadDocumentIntoEditor = useCallback((doc) => {
    if (!doc) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    activeDocIdRef.current = doc.id;
    setActiveDoc(doc);
    setTitle(doc.title || 'Untitled Document');
    titleRef.current = doc.title || 'Untitled Document';
    const md = doc.content_md || '';
    setRawMarkdown(md);
    setSaveStatus('saved');
    setPreAiMarkdown(null);
    setAiReviewResult('');
    setPreviewVersion(null);

    if (editor) {
      isHydratingRef.current = true;
      editor.commands.setContent(md);
      setHasAIChanges(checkHasAIChanges(editor));
      setTimeout(() => {
        isHydratingRef.current = false;
      }, 0);
    }

    loadVersions(doc.id);
  }, [editor, checkHasAIChanges, loadVersions]);

  const loadDocuments = useCallback(async (preferredId = null) => {
    setIsLoading(true);
    try {
      const list = await api.getDocuments();
      setDocuments(list);
      const targetId = preferredId || initialDocumentId;
      let chosen = targetId ? list.find((d) => d.id === targetId) : null;
      if (!chosen && list.length > 0) {
        chosen = list[0];
      }
      if (chosen) {
        loadDocumentIntoEditor(chosen);
      } else {
        activeDocIdRef.current = null;
        setActiveDoc(null);
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    } finally {
      setIsLoading(false);
    }
  }, [initialDocumentId, loadDocumentIntoEditor]);

  useEffect(() => {
    loadDocuments();
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (aiAbortRef.current) aiAbortRef.current.abort();
    };
  }, []);

  // Handle cross-view "Send to Writer" / "Open in Writer" payloads
  useEffect(() => {
    if (!writerSeedPayload) return;

    const applySeed = async () => {
      const { title: seedTitle, contentMd: seedContent, obsidianRelPath, mode = 'new' } = writerSeedPayload;
      try {
        if (mode === 'append' && activeDocIdRef.current && editor) {
          const currentMd = isRawMode ? rawMarkdown : editor.storage.markdown.getMarkdown();
          const combined = currentMd.trim() ? `${currentMd.trim()}\n\n${seedContent}` : seedContent;
          isHydratingRef.current = true;
          editor.commands.setContent(combined);
          setRawMarkdown(combined);
          setTimeout(() => { isHydratingRef.current = false; }, 0);
          await persistDocument(activeDocIdRef.current, titleRef.current, combined);
        } else {
          // Check if a document is already linked to this obsidianRelPath
          const existingLinked = obsidianRelPath
            ? documents.find((d) => d.obsidian_rel_path === obsidianRelPath)
            : null;
          if (existingLinked) {
            loadDocumentIntoEditor(existingLinked);
          } else {
            const created = await api.createDocument({
              title: seedTitle || 'Imported Note',
              contentMd: seedContent || '',
              obsidianRelPath: obsidianRelPath || null
            });
            setDocuments((prev) => [created, ...prev]);
            loadDocumentIntoEditor(created);
          }
        }
      } catch (err) {
        console.error('Failed to open seed in writer:', err);
      } finally {
        if (onClearWriterSeed) onClearWriterSeed();
      }
    };

    applySeed();
  }, [writerSeedPayload]);

  useEffect(() => {
    if (initialDocumentId && documents.length > 0) {
      const target = documents.find((d) => d.id === initialDocumentId);
      if (target) {
        loadDocumentIntoEditor(target);
      } else {
        loadDocuments(initialDocumentId);
      }
      if (onClearInitialDocument) onClearInitialDocument();
    }
  }, [initialDocumentId]);

  // Source Picker search (Conversations + Obsidian Notes)
  const searchSources = useCallback(async (q) => {
    setIsSearchingSources(true);
    try {
      if (!q.trim()) {
        const [convs, notes] = await Promise.all([
          api.getConversations().catch(() => []),
          api.getObsidianNotes('', 20).catch(() => [])
        ]);
        const convItems = (convs || []).slice(0, 12).map((c) => ({
          id: `conv-${c.id}`,
          convId: c.id,
          type: 'conversation',
          title: c.title || 'Untitled Conversation',
          meta: `${c.default_provider || 'AI'} • ${new Date(c.updated_at).toLocaleDateString()}`,
          content: null
        }));
        const noteItems = (notes || []).slice(0, 15).map((n) => ({
          id: `note-${n.id}`,
          type: 'obsidian_note',
          title: n.title || n.file_name,
          meta: n.rel_path,
          content: n.content || n.preview || ''
        }));
        setSourceResults([...noteItems, ...convItems]);
      } else {
        const data = await api.searchArchive(q, 'all', 'hybrid');
        const results = (data?.results || []).slice(0, 30).map((r, idx) => ({
          id: `${r.result_type || 'msg'}-${r.id || idx}`,
          type: r.result_type === 'obsidian_note' ? 'obsidian_note' : 'message',
          title: r.conversation_title || r.title || (r.result_type === 'obsidian_note' ? 'Obsidian Note' : 'Conversation Message'),
          meta: r.rel_path || `${r.role || 'assistant'} • ${r.timestamp ? new Date(r.timestamp).toLocaleDateString() : ''}`,
          content: r.content || r.snippet || ''
        }));
        setSourceResults(results);
      }
    } catch (err) {
      console.error('Source search failed:', err);
    } finally {
      setIsSearchingSources(false);
    }
  }, []);

  useEffect(() => {
    if (leftTab !== 'sources') return;
    const timer = setTimeout(() => {
      searchSources(sourceQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [leftTab, sourceQuery, searchSources]);

  const resolveSourceContent = async (item) => {
    if (item.content !== null && item.content !== undefined) return item.content;
    if (item.type === 'conversation' && item.convId) {
      const conv = await api.getConversation(item.convId);
      const msgs = conv?.messages || [];
      return msgs.map((m) => `**${m.role === 'user' ? 'User' : 'Assistant'}:**\n${m.content}`).join('\n\n---\n\n');
    }
    return '';
  };

  const handleCopySource = async (item) => {
    const text = await resolveSourceContent(item);
    await navigator.clipboard.writeText(text);
    setSyncMessage({ type: 'success', text: `Copied "${item.title}" to clipboard` });
    setTimeout(() => setSyncMessage(null), 2500);
  };

  const handleInsertSource = async (item) => {
    if (!activeDoc) return;
    const text = await resolveSourceContent(item);
    if (!text) return;

    if (isRawMode) {
      const nextMd = rawMarkdown ? `${rawMarkdown}\n\n${text}` : text;
      setRawMarkdown(nextMd);
      scheduleAutoSave(activeDoc.id, titleRef.current, nextMd);
    } else if (editor) {
      editor.chain().focus().insertContent(text).run();
    }
    setSyncMessage({ type: 'success', text: `Inserted "${item.title}" into document` });
    setTimeout(() => setSyncMessage(null), 2500);
  };

  const handleCreateDocument = async () => {
    try {
      const created = await api.createDocument({
        title: 'Untitled Document',
        contentMd: ''
      });
      setDocuments((prev) => [created, ...prev]);
      loadDocumentIntoEditor(created);
    } catch (err) {
      console.error('Failed to create document:', err);
    }
  };

  const handleDeleteDocument = async (docId, e) => {
    e.stopPropagation();
    try {
      await api.deleteDocument(docId);
      const remaining = documents.filter((d) => d.id !== docId);
      setDocuments(remaining);
      if (activeDocIdRef.current === docId) {
        if (remaining.length > 0) {
          loadDocumentIntoEditor(remaining[0]);
        } else {
          activeDocIdRef.current = null;
          setActiveDoc(null);
          setTitle('');
          setRawMarkdown('');
          editor?.commands.setContent('');
        }
      }
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  const handleTitleChange = (e) => {
    const nextTitle = e.target.value;
    setTitle(nextTitle);
    titleRef.current = nextTitle;
    if (activeDocIdRef.current) {
      const currentMd = isRawMode ? rawMarkdown : (editor?.storage.markdown.getMarkdown() || '');
      scheduleAutoSave(activeDocIdRef.current, nextTitle, currentMd);
    }
  };

  const handleRawMarkdownChange = (e) => {
    const nextMd = e.target.value;
    setRawMarkdown(nextMd);
    if (activeDocIdRef.current) {
      scheduleAutoSave(activeDocIdRef.current, titleRef.current, nextMd);
    }
  };

  const handleToggleRawMode = () => {
    if (isRawMode) {
      if (editor) {
        isHydratingRef.current = true;
        editor.commands.setContent(rawMarkdown);
        setTimeout(() => { isHydratingRef.current = false; }, 0);
      }
      setIsRawMode(false);
    } else {
      if (editor) {
        setRawMarkdown(editor.storage.markdown.getMarkdown());
      }
      setIsRawMode(true);
    }
  };

  const handleSyncToObsidian = async () => {
    if (!activeDoc) return;
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const currentMd = isRawMode ? rawMarkdown : (editor?.storage.markdown.getMarkdown() || '');
      await persistDocument(activeDoc.id, titleRef.current, currentMd);
      const res = await api.syncDocumentObsidian(activeDoc.id);
      if (res.synced) {
        setSyncMessage({ type: 'success', text: `Synced to ${res.relPath}` });
      } else {
        setSyncMessage({ type: 'warn', text: res.reason || 'Obsidian vault not configured' });
      }
    } catch (err) {
      setSyncMessage({ type: 'error', text: err.message });
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncMessage(null), 4000);
    }
  };

  const handleSaveVersion = async (customLabel) => {
    if (!activeDoc) return;
    setIsSavingVersion(true);
    try {
      const currentMd = isRawMode ? rawMarkdown : (editor?.storage.markdown.getMarkdown() || '');
      await persistDocument(activeDoc.id, titleRef.current, currentMd);
      const saved = await api.saveDocumentVersion(activeDoc.id, {
        label: (customLabel ?? versionLabel).trim() || undefined,
        authorType: 'user'
      });
      setVersionLabel('');
      setShowSaveVersionBox(false);
      setSyncMessage({ type: 'success', text: `Saved v${saved.version_number}: ${saved.label}` });
      const refreshed = await api.getDocument(activeDoc.id);
      setActiveDoc(refreshed);
      setDocuments((prev) => prev.map((d) => (d.id === refreshed.id ? refreshed : d)));
      await loadVersions(activeDoc.id);
      setTimeout(() => setSyncMessage(null), 3500);
    } catch (err) {
      setSyncMessage({ type: 'error', text: err.message });
    } finally {
      setIsSavingVersion(false);
    }
  };

  const handlePreviewVersion = async (ver) => {
    if (!activeDoc) return;
    try {
      const fullVer = await api.getDocumentVersion(activeDoc.id, ver.id);
      setPreviewVersion(fullVer);
    } catch (err) {
      setSyncMessage({ type: 'error', text: err.message });
    }
  };

  const handleRestoreVersion = async (versionId) => {
    if (!activeDoc) return;
    try {
      const restored = await api.restoreDocumentVersion(activeDoc.id, versionId);
      setDocuments((prev) => prev.map((d) => (d.id === restored.id ? restored : d)));
      loadDocumentIntoEditor(restored);
      setSyncMessage({ type: 'success', text: 'Restored selected version (previous draft auto-backed up)' });
      setTimeout(() => setSyncMessage(null), 3500);
    } catch (err) {
      setSyncMessage({ type: 'error', text: err.message });
    }
  };

  const handleAcceptAllAIChanges = () => {
    if (!editor) return;
    editor.commands.clearAllAIChanges();
    setHasAIChanges(false);
    setPreAiMarkdown(null);
    if (activeDoc) {
      const currentMd = editor.storage.markdown.getMarkdown();
      persistDocument(activeDoc.id, titleRef.current, currentMd, null);
    }
  };

  const handleRevertAIChanges = () => {
    if (preAiMarkdown === null || !activeDoc) return;
    if (isRawMode) {
      setRawMarkdown(preAiMarkdown);
    } else if (editor) {
      isHydratingRef.current = true;
      editor.commands.setContent(preAiMarkdown);
      setHasAIChanges(false);
      setTimeout(() => { isHydratingRef.current = false; }, 0);
    }
    persistDocument(activeDoc.id, titleRef.current, preAiMarkdown, null);
    setPreAiMarkdown(null);
    setSyncMessage({ type: 'warn', text: 'Reverted AI changes' });
    setTimeout(() => setSyncMessage(null), 3000);
  };

  const getSelectionMarkdown = () => {
    if (!editor) return { text: '', from: 0, to: 0 };
    const { from, to, empty } = editor.state.selection;
    if (empty) return { text: '', from, to };
    const text = editor.state.doc.textBetween(from, to, '\n\n');
    return { text, from, to };
  };

  const handleRunAI = async (overrideAction = null, overrideInstruction = null) => {
    if (!activeDoc || isAiRunning) return;
    const actionToRun = overrideAction || aiAction;
    const instructionToRun = overrideInstruction !== null ? overrideInstruction : aiInstruction;
    const currentFullMd = isRawMode ? rawMarkdown : (editor?.storage.markdown.getMarkdown() || '');
    const sel = !isRawMode ? getSelectionMarkdown() : { text: '', from: 0, to: 0 };
    const useSelection = aiScope === 'selection' && sel.text.trim().length > 0;

    setIsAiRunning(true);
    setAiStreamOutput('');
    if (actionToRun === 'review') setAiReviewResult('');

    const abortController = new AbortController();
    aiAbortRef.current = abortController;

    let streamed = '';
    try {
      await api.streamDocumentAI({
        documentId: activeDoc.id,
        action: actionToRun,
        instruction: instructionToRun,
        provider: aiProvider,
        model: aiModel,
        fullDocumentMd: currentFullMd,
        selectedTextMd: useSelection ? sel.text : '',
        autoSnapshot: true,
        abortSignal: abortController.signal,
        onChunk: (chunk) => {
          streamed += chunk;
          setAiStreamOutput(streamed);
        },
        onError: (errMsg) => {
          setSyncMessage({ type: 'error', text: errMsg });
        },
        onDone: async (donePayload) => {
          const finalText = stripOuterCodeFences(donePayload.text || streamed);
          if (donePayload.status === 'error' || !finalText.trim()) return;

          if (actionToRun === 'review') {
            setAiReviewResult(finalText);
          } else {
            setPreAiMarkdown(currentFullMd);
            if (useSelection && editor && !isRawMode) {
              const highlightedSelectionHtml = buildHighlightedMarkdown(
                sel.text,
                finalText,
                donePayload.provider || aiProvider,
                donePayload.model || aiModel
              );
              editor.chain().focus().insertContentAt({ from: sel.from, to: sel.to }, highlightedSelectionHtml).run();
              setHasAIChanges(true);
            } else if (editor) {
              const highlightedFull = buildHighlightedMarkdown(
                currentFullMd,
                finalText,
                donePayload.provider || aiProvider,
                donePayload.model || aiModel
              );
              if (isRawMode) {
                setIsRawMode(false);
              }
              isHydratingRef.current = true;
              editor.commands.setContent(highlightedFull);
              setRawMarkdown(finalText);
              setHasAIChanges(true);
              setTimeout(() => { isHydratingRef.current = false; }, 0);
              await persistDocument(activeDoc.id, titleRef.current, finalText);
            }
            await loadVersions(activeDoc.id);
          }
        }
      });
    } catch (err) {
      if (!abortController.signal.aborted) {
        setSyncMessage({ type: 'error', text: err.message });
      }
    } finally {
      setIsAiRunning(false);
      setAiStreamOutput('');
      aiAbortRef.current = null;
    }
  };

  const handleStopAI = () => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort();
    }
  };

  const handleSetLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href || '';
    const url = window.prompt('Enter URL:', previousUrl);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const getCurrentBlockType = () => {
    if (!editor) return 'p';
    if (editor.isActive('heading', { level: 1 })) return 'h1';
    if (editor.isActive('heading', { level: 2 })) return 'h2';
    if (editor.isActive('heading', { level: 3 })) return 'h3';
    return 'p';
  };

  const handleBlockTypeChange = (e) => {
    if (!editor) return;
    const val = e.target.value;
    if (val === 'p') editor.chain().focus().setParagraph().run();
    if (val === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run();
    if (val === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
    if (val === 'h3') editor.chain().focus().toggleHeading({ level: 3 }).run();
  };

  const wordCount = activeDoc?.word_count ?? (rawMarkdown.trim() ? rawMarkdown.trim().split(/\s+/).length : 0);
  const availableProviders = ['gemini', 'openai', 'ollama', 'lmstudio'];
  const currentModels = providerHealth?.[aiProvider]?.models || [];

  return (
    <div className="writer-container">
      {/* Left Rail: Documents List & Source Picker */}
      <aside className="writer-docs-rail">
        <div className="writer-rail-tabs">
          <button
            className={`writer-rail-tab ${leftTab === 'docs' ? 'active' : ''}`}
            onClick={() => setLeftTab('docs')}
          >
            <FileText size={13} />
            <span>Documents</span>
          </button>
          <button
            className={`writer-rail-tab ${leftTab === 'sources' ? 'active' : ''}`}
            onClick={() => setLeftTab('sources')}
          >
            <Search size={13} />
            <span>Insert Source</span>
          </button>
        </div>

        {leftTab === 'docs' ? (
          <>
            <div className="writer-rail-header">
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                {documents.length} {documents.length === 1 ? 'Document' : 'Documents'}
              </span>
              <button className="writer-new-btn" onClick={handleCreateDocument} title="New Document">
                <Plus size={14} />
                <span>New</span>
              </button>
            </div>

            <div className="writer-docs-list">
              {isLoading ? (
                <div className="writer-empty-hint">Loading documents...</div>
              ) : documents.length === 0 ? (
                <div className="writer-empty-hint">
                  No documents yet.<br />Click <strong>New</strong> to start writing.
                </div>
              ) : (
                documents.map((doc) => (
                  <div
                    key={doc.id}
                    className={`writer-doc-item ${activeDoc?.id === doc.id ? 'active' : ''}`}
                    onClick={() => loadDocumentIntoEditor(doc)}
                  >
                    <div className="writer-doc-item-info">
                      <div className="writer-doc-item-title">{doc.title || 'Untitled Document'}</div>
                      <div className="writer-doc-item-meta">
                        <span>{doc.word_count || 0} words</span>
                        <span>•</span>
                        <span>v{doc.version_count || 1}</span>
                        <span>•</span>
                        <span>{new Date(doc.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                      </div>
                    </div>
                    <button
                      className="writer-doc-delete-btn"
                      title="Delete document"
                      onClick={(e) => handleDeleteDocument(doc.id, e)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="writer-source-picker">
            <div className="writer-source-search-box">
              <Search size={13} color="var(--text-muted)" />
              <input
                type="text"
                placeholder="Search chats & Obsidian notes..."
                value={sourceQuery}
                onChange={(e) => setSourceQuery(e.target.value)}
              />
              {sourceQuery && (
                <button className="writer-clear-btn" onClick={() => setSourceQuery('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="writer-docs-list">
              {isSearchingSources ? (
                <div className="writer-empty-hint">Searching archive...</div>
              ) : sourceResults.length === 0 ? (
                <div className="writer-empty-hint">No matching notes or conversations.</div>
              ) : (
                sourceResults.map((item) => (
                  <div key={item.id} className="writer-source-card">
                    <div className="writer-source-card-top">
                      {item.type === 'obsidian_note' ? (
                        <BookOpen size={12} color="#c084fc" />
                      ) : (
                        <MessageSquare size={12} color="#38bdf8" />
                      )}
                      <span className="writer-source-title">{item.title}</span>
                    </div>
                    <div className="writer-source-meta">{item.meta}</div>
                    {item.content && (
                      <div className="writer-source-preview">{item.content.slice(0, 110)}</div>
                    )}
                    <div className="writer-source-actions">
                      <button onClick={() => handleCopySource(item)} title="Copy to clipboard">
                        <Copy size={11} />
                        <span>Copy</span>
                      </button>
                      <button
                        className="insert"
                        onClick={() => handleInsertSource(item)}
                        disabled={!activeDoc}
                        title="Insert at cursor in active document"
                      >
                        <CornerDownLeft size={11} />
                        <span>Insert</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </aside>

      {/* Center: Word-Like Document Canvas */}
      <section className="writer-main-workspace">
        {!activeDoc ? (
          <div className="writer-empty-state">
            <FileText size={44} color="var(--text-muted)" />
            <h2>Document Writer</h2>
            <p>Create rich Markdown documents synced with Obsidian, edit with local or cloud AI, and track version history.</p>
            <button className="btn-new-chat" style={{ width: 'auto', padding: '10px 20px' }} onClick={handleCreateDocument}>
              <Plus size={16} />
              <span>Create Your First Document</span>
            </button>
          </div>
        ) : (
          <>
            {/* Top Document Header */}
            <header className="writer-header">
              <div className="writer-title-wrap">
                <input
                  type="text"
                  className="writer-title-input"
                  value={title}
                  onChange={handleTitleChange}
                  placeholder="Document Title..."
                />
                <div className="writer-status-pills">
                  <span className={`writer-save-badge ${saveStatus}`}>
                    {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'unsaved' ? 'Unsaved' : 'Saved'}
                  </span>
                  <span className="writer-meta-badge">{wordCount} words</span>
                  {activeDoc.obsidian_rel_path && (
                    <span className="writer-meta-badge" title={activeDoc.obsidian_rel_path}>
                      Markdown (.md)
                    </span>
                  )}
                </div>
              </div>

              <div className="writer-header-actions">
                <button
                  className={`writer-action-btn ${isRawMode ? 'active' : ''}`}
                  onClick={handleToggleRawMode}
                  title={isRawMode ? 'Switch to Word-like WYSIWYG View' : 'Inspect Raw Markdown'}
                >
                  {isRawMode ? <Eye size={15} /> : <Code2 size={15} />}
                  <span>{isRawMode ? 'Rich View' : 'Markdown'}</span>
                </button>

                <div style={{ position: 'relative' }}>
                  <button
                    className="writer-action-btn"
                    onClick={() => setShowSaveVersionBox((v) => !v)}
                    title="Save a named version snapshot"
                  >
                    <BookmarkPlus size={15} />
                    <span>Save Version</span>
                  </button>

                  {showSaveVersionBox && (
                    <div className="writer-version-popover">
                      <input
                        type="text"
                        placeholder="Version label (e.g. Draft 2)"
                        value={versionLabel}
                        onChange={(e) => setVersionLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveVersion();
                          if (e.key === 'Escape') setShowSaveVersionBox(false);
                        }}
                        autoFocus
                      />
                      <button onClick={() => handleSaveVersion()} disabled={isSavingVersion}>
                        {isSavingVersion ? 'Saving...' : 'Save'}
                      </button>
                    </div>
                  )}
                </div>

                <button
                  className="writer-action-btn primary"
                  onClick={handleSyncToObsidian}
                  disabled={isSyncing}
                  title="Write Markdown file to Obsidian Vault"
                >
                  <RefreshCw size={15} className={isSyncing ? 'spin' : ''} />
                  <span>{isSyncing ? 'Syncing...' : 'Sync Obsidian'}</span>
                </button>

                <button
                  className="writer-action-btn"
                  onClick={() => setIsRightOpen((v) => !v)}
                  title={isRightOpen ? 'Hide AI & Versions Panel' : 'Show AI & Versions Panel'}
                >
                  {isRightOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                </button>
              </div>
            </header>

            {syncMessage && (
              <div className={`writer-toast ${syncMessage.type}`}>
                <CheckCircle2 size={14} />
                <span>{syncMessage.text}</span>
              </div>
            )}

            {/* Word-Style Formatting Toolbar */}
            {!isRawMode && editor && (
              <div className="writer-toolbar">
                <button
                  className="toolbar-btn"
                  onClick={() => editor.chain().focus().undo().run()}
                  disabled={!editor.can().undo()}
                  title="Undo"
                >
                  <Undo2 size={15} />
                </button>
                <button
                  className="toolbar-btn"
                  onClick={() => editor.chain().focus().redo().run()}
                  disabled={!editor.can().redo()}
                  title="Redo"
                >
                  <Redo2 size={15} />
                </button>

                <div className="toolbar-divider" />

                <select
                  className="toolbar-select"
                  value={getCurrentBlockType()}
                  onChange={handleBlockTypeChange}
                  title="Text style"
                >
                  <option value="p">Normal Text</option>
                  <option value="h1">Heading 1</option>
                  <option value="h2">Heading 2</option>
                  <option value="h3">Heading 3</option>
                </select>

                <div className="toolbar-divider" />

                <button
                  className={`toolbar-btn ${editor.isActive('bold') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  title="Bold (Cmd+B)"
                >
                  <Bold size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('italic') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                  title="Italic (Cmd+I)"
                >
                  <Italic size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('underline') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                  title="Underline (Cmd+U)"
                >
                  <UnderlineIcon size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('strike') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                  title="Strikethrough"
                >
                  <Strikethrough size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('code') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleCode().run()}
                  title="Inline Code"
                >
                  <Code size={15} />
                </button>

                <div className="toolbar-divider" />

                <button
                  className={`toolbar-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  title="Bullet List"
                >
                  <List size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                  title="Numbered List"
                >
                  <ListOrdered size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('taskList') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleTaskList().run()}
                  title="Task Checklist"
                >
                  <CheckSquare size={15} />
                </button>

                <div className="toolbar-divider" />

                <button
                  className={`toolbar-btn ${editor.isActive('blockquote') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                  title="Blockquote"
                >
                  <Quote size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('codeBlock') ? 'active' : ''}`}
                  onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                  title="Code Block"
                >
                  <FileCode size={15} />
                </button>
                <button
                  className={`toolbar-btn ${editor.isActive('link') ? 'active' : ''}`}
                  onClick={handleSetLink}
                  title="Insert Link"
                >
                  <LinkIcon size={15} />
                </button>
                <button
                  className="toolbar-btn"
                  onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
                  title="Insert 3x3 Table"
                >
                  <TableIcon size={15} />
                </button>
              </div>
            )}

            {/* AI Change Highlight Banner */}
            {hasAIChanges && !isRawMode && (
              <div className="writer-ai-banner">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Sparkles size={15} color="#22d3ee" />
                  <span>AI changes are highlighted in cyan. Saved Markdown remains clean.</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {preAiMarkdown !== null && (
                    <button className="writer-reject-ai-btn" onClick={handleRevertAIChanges}>
                      <RotateCcw size={13} />
                      <span>Revert</span>
                    </button>
                  )}
                  <button className="writer-accept-ai-btn" onClick={handleAcceptAllAIChanges}>
                    <Check size={14} />
                    <span>Accept All & Clear Highlights</span>
                  </button>
                </div>
              </div>
            )}

            {/* Document Page Surface */}
            <div className="writer-canvas-scroll">
              <div className="writer-page-sheet">
                {isRawMode ? (
                  <textarea
                    className="writer-raw-textarea"
                    value={rawMarkdown}
                    onChange={handleRawMarkdownChange}
                    placeholder="Write pure Markdown here..."
                    spellCheck={true}
                  />
                ) : (
                  <EditorContent editor={editor} />
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {/* Right Utility Drawer: AI Assistant & Version History */}
      {activeDoc && (
        <aside className={`writer-right-drawer ${!isRightOpen ? 'collapsed' : ''}`}>
          {!isRightOpen ? (
            <div className="writer-right-collapsed-rail">
              <button
                className="toolbar-btn"
                onClick={() => setIsRightOpen(true)}
                title="Expand AI & Versions Panel"
              >
                <PanelRightOpen size={16} />
              </button>
              <button
                className={`toolbar-btn ${rightTab === 'ai' ? 'active' : ''}`}
                onClick={() => {
                  setRightTab('ai');
                  setIsRightOpen(true);
                }}
                title="AI Assistant"
              >
                <Wand2 size={16} />
              </button>
              <button
                className={`toolbar-btn ${rightTab === 'versions' ? 'active' : ''}`}
                onClick={() => {
                  setRightTab('versions');
                  setIsRightOpen(true);
                }}
                title={`Versions (${versions.length})`}
              >
                <History size={16} />
              </button>
            </div>
          ) : (
            <>
              <div className="writer-rail-tabs">
                <button
                  className={`writer-rail-tab ${rightTab === 'ai' ? 'active' : ''}`}
                  onClick={() => setRightTab('ai')}
                >
                  <Wand2 size={13} />
                  <span>AI Assistant</span>
                </button>
                <button
                  className={`writer-rail-tab ${rightTab === 'versions' ? 'active' : ''}`}
                  onClick={() => setRightTab('versions')}
                >
                  <History size={13} />
                  <span>Versions ({versions.length})</span>
                </button>
                <button
                  className="writer-drawer-collapse-btn"
                  onClick={() => setIsRightOpen(false)}
                  title="Collapse right pane"
                >
                  <PanelRightClose size={14} />
                </button>
              </div>

          {rightTab === 'ai' ? (
            <div className="writer-drawer-body">
              {/* Provider & Model Selector */}
              <div className="writer-field-group">
                <label>AI Provider & Model (Local or Cloud)</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <select
                    className="writer-select"
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value)}
                  >
                    {availableProviders.map((p) => {
                      const online = providerHealth?.[p]?.available;
                      const label = p === 'lmstudio' ? 'LM Studio' : p.charAt(0).toUpperCase() + p.slice(1);
                      return (
                        <option key={p} value={p}>
                          {label} {online ? '●' : '○'}
                        </option>
                      );
                    })}
                  </select>
                  <select
                    className="writer-select"
                    style={{ flex: 1 }}
                    value={aiModel}
                    onChange={(e) => setAiModel(e.target.value)}
                  >
                    {currentModels.length === 0 ? (
                      <option value="">Default model</option>
                    ) : (
                      currentModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))
                    )}
                  </select>
                </div>
              </div>

              {/* Action Mode Pills */}
              <div className="writer-field-group">
                <label>Action Mode</label>
                <div className="writer-pill-grid">
                  {[
                    { id: 'edit', label: 'Edit' },
                    { id: 'refine', label: 'Refine' },
                    { id: 'update', label: 'Update' },
                    { id: 'review', label: 'Review' }
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      className={`writer-mode-pill ${aiAction === mode.id ? 'active' : ''}`}
                      onClick={() => setAiAction(mode.id)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scope Toggle */}
              <div className="writer-field-group">
                <label>Target Scope</label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    className={`writer-scope-btn ${aiScope === 'document' ? 'active' : ''}`}
                    onClick={() => setAiScope('document')}
                  >
                    Entire Document
                  </button>
                  <button
                    className={`writer-scope-btn ${aiScope === 'selection' ? 'active' : ''}`}
                    onClick={() => setAiScope('selection')}
                  >
                    Selection
                  </button>
                </div>
              </div>

              {/* Instruction Prompt */}
              <div className="writer-field-group">
                <label>Instructions</label>
                <textarea
                  className="writer-ai-prompt"
                  rows={4}
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  placeholder={
                    aiAction === 'review'
                      ? 'e.g., Check for logical gaps, tone consistency, and missing details...'
                      : 'e.g., Make this more concise, fix grammar, and format key points as bullets...'
                  }
                />
                <div className="writer-quick-chips">
                  {[
                    'Polish grammar & flow',
                    'Make concise',
                    'Expand with details',
                    'Executive summary'
                  ].map((chip) => (
                    <button key={chip} onClick={() => setAiInstruction(chip)}>
                      {chip}
                    </button>
                  ))}
                </div>
              </div>

              {isAiRunning ? (
                <button className="writer-run-ai-btn stop" onClick={handleStopAI}>
                  <Square size={13} />
                  <span>Stop AI Generation</span>
                </button>
              ) : (
                <button className="writer-run-ai-btn" onClick={() => handleRunAI()}>
                  <Sparkles size={14} />
                  <span>Run AI {aiAction.charAt(0).toUpperCase() + aiAction.slice(1)}</span>
                </button>
              )}

              {/* Live Streaming Output */}
              {isAiRunning && aiStreamOutput && (
                <div className="writer-ai-output-card">
                  <div className="writer-ai-output-header">Streaming from {aiProvider}...</div>
                  <pre className="writer-ai-output-body">{aiStreamOutput}</pre>
                </div>
              )}

              {/* Review Critique Card */}
              {aiReviewResult && (
                <div className="writer-ai-output-card">
                  <div className="writer-ai-output-header">
                    <span>AI Review Notes</span>
                    <button
                      className="writer-apply-review-btn"
                      onClick={() => {
                        setAiAction('edit');
                        handleRunAI('edit', `Apply these editorial review improvements:\n\n${aiReviewResult}`);
                      }}
                    >
                      Apply Suggestions
                    </button>
                  </div>
                  <div className="writer-ai-review-text">{aiReviewResult}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="writer-drawer-body">
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  className="writer-version-input"
                  placeholder="Label (e.g. Before AI polish)"
                  value={versionLabel}
                  onChange={(e) => setVersionLabel(e.target.value)}
                />
                <button
                  className="writer-new-btn"
                  onClick={() => handleSaveVersion(versionLabel)}
                  disabled={isSavingVersion}
                >
                  Save
                </button>
              </div>

              {previewVersion && (
                <div className="writer-version-preview-card">
                  <div className="writer-ai-output-header">
                    <span>v{previewVersion.version_number}: {previewVersion.label}</span>
                    <button className="writer-clear-btn" onClick={() => setPreviewVersion(null)}>
                      <X size={13} />
                    </button>
                  </div>
                  <div className="writer-version-diff-box">
                    {diffWords(previewVersion.content_md || '', rawMarkdown || '').map((part, idx) => (
                      <span
                        key={idx}
                        className={part.added ? 'diff-added' : part.removed ? 'diff-removed' : ''}
                      >
                        {part.value}
                      </span>
                    ))}
                  </div>
                  <button
                    className="writer-run-ai-btn"
                    style={{ marginTop: '8px' }}
                    onClick={() => handleRestoreVersion(previewVersion.id)}
                  >
                    <RotateCcw size={13} />
                    <span>Restore v{previewVersion.version_number}</span>
                  </button>
                </div>
              )}

              <div className="writer-versions-list">
                {isLoadingVersions ? (
                  <div className="writer-empty-hint">Loading versions...</div>
                ) : versions.length === 0 ? (
                  <div className="writer-empty-hint">No saved versions yet.</div>
                ) : (
                  versions.map((v) => (
                    <div
                      key={v.id}
                      className={`writer-version-item ${activeDoc.current_version_id === v.id ? 'current' : ''}`}
                      onClick={() => handlePreviewVersion(v)}
                    >
                      <div className="writer-version-item-top">
                        <span className="writer-version-num">v{v.version_number}</span>
                        <span className="writer-version-label">{v.label || 'Snapshot'}</span>
                        <span className={`writer-author-tag ${v.author_type}`}>{v.author_type}</span>
                      </div>
                      <div className="writer-version-item-meta">
                        <span>{new Date(v.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        {v.model && <span>• {v.model}</span>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
            </>
          )}
        </aside>
      )}
    </div>
  );
}
