import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ArchiveView from './components/ArchiveView';
import SummaryView from './components/SummaryView';
import ObsidianNotesView from './components/ObsidianNotesView';
import SettingsModal from './components/SettingsModal';
import { api } from './api';

export default function App() {
  const [currentView, setCurrentView] = useState('chat'); // 'chat' | 'archive' | 'summary' | 'obsidian'
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [externalInputText, setExternalInputText] = useState('');

  // App Data State
  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState(null);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [categories, setCategories] = useState([]);
  const [providerHealth, setProviderHealth] = useState(null);

  // Model & Provider Selection
  const [selectedProvider, setSelectedProvider] = useState('gemini');
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash');

  // Streaming & Submission State
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isSubmittingPost, setIsSubmittingPost] = useState(false);
  const abortControllerRef = useRef(null);

  // Initial Load
  useEffect(() => {
    loadHealth();
    loadConversations();
    loadSummaries();
    loadCategories();
  }, []);

  const loadHealth = async () => {
    try {
      const h = await api.getHealth();
      setProviderHealth(h);
      setSelectedProvider((prev) => {
        if (prev) return prev;
        if (h.gemini?.available && h.gemini.models?.length > 0) return 'gemini';
        if (h.ollama?.available && h.ollama.models?.length > 0) return 'ollama';
        if (h.lmstudio?.available && h.lmstudio.models?.length > 0) return 'lmstudio';
        return 'gemini';
      });
    } catch (err) {
      console.error('Failed to load health:', err);
    }
  };

  const loadConversations = async () => {
    try {
      const convs = await api.getConversations();
      setConversations(convs);
      if (convs.length > 0 && !activeConvId) {
        selectConversation(convs[0].id);
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  };

  const selectConversation = async (id, keepCurrentModel = false) => {
    setActiveConvId(id);
    try {
      const convData = await api.getConversation(id);
      setCurrentConversation(convData);
      setMessages(convData.messages || []);
      if (!keepCurrentModel) {
        const targetProvider = convData.default_provider || convData.provider;
        const targetModel = convData.default_model || convData.model;
        if (targetProvider) setSelectedProvider(targetProvider);
        if (targetModel) setSelectedModel(targetModel);
      }
    } catch (err) {
      console.error('Failed to load conversation details:', err);
    }
  };

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation({
        title: 'New Conversation',
        provider: selectedProvider,
        model: selectedModel
      });
      setConversations([newConv, ...conversations]);
      setActiveConvId(newConv.id);
      setCurrentConversation(newConv);
      setMessages([]);
      setCurrentView('chat');
    } catch (err) {
      console.error('Failed to create new conversation:', err);
    }
  };

  const handleDeleteConversation = async (id) => {
    if (!window.confirm('Delete this conversation from archive?')) return;
    try {
      await api.deleteConversation(id);
      const remaining = conversations.filter(c => c.id !== id);
      setConversations(remaining);
      if (activeConvId === id) {
        if (remaining.length > 0) {
          selectConversation(remaining[0].id);
        } else {
          setActiveConvId(null);
          setCurrentConversation(null);
          setMessages([]);
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err);
    }
  };

  const loadSummaries = async () => {
    try {
      const s = await api.getSummaries();
      setSummaries(s);
    } catch (err) {
      console.error('Failed to load summaries:', err);
    }
  };

  const loadCategories = async () => {
    try {
      const c = await api.getCategories();
      setCategories(c);
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  };

  // Unified Post Submission with Live SSE Streaming (Merging Strategy)
  const handleCreatePost = async ({ content, mode, attachment }) => {
    if (isSubmittingPost || isStreaming) return;
    setIsSubmittingPost(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Optimistically add user message immediately
    const tempUserMsg = {
      id: 'temp-' + Date.now(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachments: attachment ? [attachment] : []
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    const isAIMode = mode === 'ai_analysis' || mode === 'google_search';
    if (isAIMode) {
      setIsStreaming(true);
      setStreamingText('');
    }

    let targetConvId = activeConvId;

    try {
      await api.streamPost({
        conversationId: activeConvId,
        content,
        mode,
        attachment,
        provider: selectedProvider,
        model: selectedModel,
        abortSignal: abortController.signal,
        onInit: (initData) => {
          if (initData.conversationId && initData.conversationId !== targetConvId) {
            targetConvId = initData.conversationId;
            setActiveConvId(targetConvId);
          }
          if (initData.userMessage) {
            setMessages((prev) => prev.map((m) => m.id === tempUserMsg.id ? initData.userMessage : m));
          }
        },
        onChunk: (chunk) => {
          setStreamingText((prev) => prev + chunk);
        },
        onError: (err) => {
          console.error('[Stream Error]:', err);
        },
        onDone: async (doneData) => {
          setIsStreaming(false);
          setStreamingText('');

          if (doneData.aiResponse) {
            setMessages((prev) => {
              const withoutTemp = prev.filter((m) => m.id !== tempUserMsg.id);
              const userMsg = doneData.userMessage || tempUserMsg;
              return [...withoutTemp, userMsg, doneData.aiResponse];
            });
          }

          if (doneData.conversationId) {
            const finalId = doneData.conversationId;
            setActiveConvId(finalId);
            const convData = await api.getConversation(finalId);
            setCurrentConversation(convData);
            setMessages(convData.messages || []);
            const convs = await api.getConversations();
            setConversations(convs);
          }
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Failed to submit post:', err);
        alert('Failed to submit post: ' + err.message);
      }
    } finally {
      setIsSubmittingPost(false);
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  const handleInsertIntoComposer = (text) => {
    setExternalInputText(text);
    setCurrentView('chat');
  };

  const handleStartChatWithNote = async (note) => {
    const promptText = `Let's discuss and analyze my Obsidian note "${note.title}":\n\n${note.content || note.preview}`;
    setExternalInputText(promptText);
    await handleNewConversation();
    setCurrentView('chat');
  };

  const handleSummarizeUrlToThread = async (url) => {
    let convId = activeConvId;

    try {
      if (!convId) {
        let domain = url;
        try { domain = new URL(url).hostname.replace('www.', ''); } catch (e) {}
        const newConv = await api.createConversation({
          title: `Summary: ${domain}`,
          provider: selectedProvider,
          model: selectedModel
        });
        convId = newConv.id;
        setConversations([newConv, ...conversations]);
        setActiveConvId(newConv.id);
        setCurrentConversation(newConv);
      }

      setCurrentView('chat');

      const userPromptText = `Please provide an AI summary of this page: ${url}`;
      const userMsg = await api.addMessage({
        conversationId: convId,
        role: 'user',
        content: userPromptText,
        provider: selectedProvider,
        model: selectedModel
      });

      const tempAssistantId = 'temp-summary-' + Date.now();
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: tempAssistantId,
          role: 'assistant',
          content: `⏳ Analyzing & synthesizing summary for ${url}...`,
          provider: selectedProvider,
          model: selectedModel,
          timestamp: new Date().toISOString()
        }
      ]);

      const res = await api.summarizeURL({ url, model: selectedModel });

      let assistantContent = res.summary;
      if (res.title && !assistantContent.includes(res.title)) {
        assistantContent = `### ${res.title}\n\n${assistantContent}`;
      }

      const assistantMsg = await api.addMessage({
        conversationId: convId,
        role: 'assistant',
        content: assistantContent,
        provider: selectedProvider,
        model: selectedModel
      });

      setMessages((prev) => prev.map((m) => (m.id === tempAssistantId ? assistantMsg : m)));
      await loadConversations();
    } catch (err) {
      console.error('Failed to summarize URL:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: 'err-' + Date.now(),
          role: 'assistant',
          status: 'error',
          content: `⚠️ Failed to generate AI summary for ${url}: ${err.message}`,
          timestamp: new Date().toISOString()
        }
      ]);
    }
  };

  return (
    <div className="app-container">
      {/* Left Sidebar */}
      <Sidebar 
        currentView={currentView}
        setCurrentView={setCurrentView}
        conversations={conversations}
        activeConvId={activeConvId}
        onSelectConversation={selectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        providerHealth={providerHealth}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      {/* Main Active View */}
      <main className="main-content">
        {currentView === 'chat' && (
          <ChatView 
            conversation={currentConversation}
            messages={messages}
            onStopStreaming={handleStopStreaming}
            isStreaming={isStreaming}
            streamingText={streamingText}
            providerHealth={providerHealth}
            selectedProvider={selectedProvider}
            setSelectedProvider={setSelectedProvider}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            externalInputText={externalInputText}
            setExternalInputText={setExternalInputText}
            onSummarizeUrl={handleSummarizeUrlToThread}
            onSubmitPost={handleCreatePost}
            isSubmitting={isSubmittingPost}
          />
        )}

        {currentView === 'archive' && (
          <ArchiveView 
            conversations={conversations}
            onSelectConversation={selectConversation}
            setCurrentView={setCurrentView}
            onSummarizeUrl={handleSummarizeUrlToThread}
          />
        )}

        {currentView === 'summary' && (
          <SummaryView 
            summaries={summaries}
            categories={categories}
            onRefreshSummaries={loadSummaries}
            providerHealth={providerHealth}
          />
        )}

        {currentView === 'obsidian' && (
          <ObsidianNotesView 
            onInsertIntoComposer={handleInsertIntoComposer}
            onStartChatWithNote={handleStartChatWithNote}
          />
        )}
      </main>

      {/* Settings Modal */}
      <SettingsModal 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSaved={loadHealth}
      />
    </div>
  );
}
