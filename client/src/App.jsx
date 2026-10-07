import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ArchiveView from './components/ArchiveView';
import SummaryView from './components/SummaryView';
import SettingsModal from './components/SettingsModal';
import GoogleSearchModal from './components/GoogleSearchModal';
import { api } from './api';

export default function App() {
  const [currentView, setCurrentView] = useState('chat'); // 'chat' | 'archive' | 'summary'
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGoogleSearchOpen, setIsGoogleSearchOpen] = useState(false);
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
  const [selectedModel, setSelectedModel] = useState('gemini-3.6-flash');

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
      // Pick initial online provider only if user hasn't selected one yet
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

  // Chat message sending with live SSE streaming
  const handleSendMessage = async ({ text, injectContext, contextMode, categoryIds }) => {
    if (isStreaming) return;

    // Optimistically append user message to local state
    const tempUserMsg = {
      id: 'temp-' + Date.now(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setIsStreaming(true);
    setStreamingText('');

    // If active conversation currently has default title, update it immediately with the first query
    const cleanTitle = text.slice(0, 40) + (text.length > 40 ? '...' : '');
    if (!currentConversation?.title || currentConversation.title === 'New Conversation' || currentConversation.title === 'Untitled Conversation') {
      setCurrentConversation((prev) => prev ? { ...prev, title: cleanTitle } : prev);
      setConversations((prev) => prev.map((c) => c.id === activeConvId ? { ...c, title: cleanTitle } : c));
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    let accumulatedText = '';

    try {
      await api.streamChat({
        conversationId: activeConvId,
        message: text,
        provider: selectedProvider,
        model: selectedModel,
        injectContext,
        contextMode,
        categoryIds,
        abortSignal: abortController.signal,
        onChunk: (chunk) => {
          accumulatedText += chunk;
          setStreamingText(accumulatedText);
        },
        onError: (err) => {
          console.error('Stream error:', err);
          setMessages((prev) => [
            ...prev,
            {
              id: 'err-' + Date.now(),
              role: 'assistant',
              status: 'error',
              content: `⚠️ Error from ${selectedProvider} (${selectedModel}): ${err}\n\nTroubleshooting Tip: Ensure your local AI service (Ollama on :11434 or LM Studio on :1234) is running and model '${selectedModel}' is loaded.`,
              timestamp: new Date().toISOString()
            }
          ]);
        },
        onDone: async (data) => {
          setIsStreaming(false);
          setStreamingText('');
          if (data.status === 'interrupted' && !accumulatedText) {
            setMessages((prev) => [
              ...prev,
              {
                id: 'interrupted-' + Date.now(),
                role: 'assistant',
                status: 'interrupted',
                content: `(Generation interrupted before tokens were received from ${selectedProvider})`,
                timestamp: new Date().toISOString()
              }
            ]);
          }
          if (data.conversationId) {
            setActiveConvId(data.conversationId);
            await selectConversation(data.conversationId, true);
            await loadConversations();
          }
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Chat error:', err);
        setMessages((prev) => [
          ...prev,
          {
            id: 'err-' + Date.now(),
            role: 'assistant',
            status: 'error',
            content: `⚠️ Network / Connection Error: ${err.message}\n\nPlease check if backend server and local model service are accessible.`,
            timestamp: new Date().toISOString()
          }
        ]);
      }
    } finally {
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

  // Triple-Action Post Submission ('standard', 'ai_analysis', 'google_search')
  const handleCreatePost = async ({ content, mode, attachment }) => {
    if (isSubmittingPost) return;
    setIsSubmittingPost(true);
    try {
      const res = await api.createPost({
        conversationId: activeConvId,
        content,
        mode,
        attachment,
        provider: selectedProvider,
        model: selectedModel
      });

      if (res.conversationId) {
        if (!activeConvId || activeConvId !== res.conversationId) {
          setActiveConvId(res.conversationId);
        }
        await selectConversation(res.conversationId, true);
        await loadConversations();
      }
    } catch (err) {
      alert('Failed to submit post: ' + err.message);
    } finally {
      setIsSubmittingPost(false);
    }
  };

  // Google Search AI Integration Handlers
  const handleInsertIntoComposer = (text) => {
    setExternalInputText(text);
    setCurrentView('chat');
  };

  const handlePostGoogleSearchToThread = async (text) => {
    if (!activeConvId) return;
    try {
      const newMsg = await api.addMessage({
        conversationId: activeConvId,
        role: 'assistant',
        content: text,
        provider: 'gemini',
        model: 'gemini-3.6-flash'
      });
      setMessages((prev) => [...prev, newMsg]);
      setCurrentView('chat');
      await loadConversations();
    } catch (err) {
      console.error('Failed to post search answer to thread:', err);
      alert('Failed to post to thread: ' + err.message);
    }
  };

  const handleNewThreadWithGoogleSearch = async ({ title, content }) => {
    try {
      const newConv = await api.createConversation({
        title,
        provider: 'gemini',
        model: 'gemini-3.6-flash'
      });
      const newMsg = await api.addMessage({
        conversationId: newConv.id,
        role: 'assistant',
        content,
        provider: 'gemini',
        model: 'gemini-3.6-flash'
      });
      setConversations([newConv, ...conversations]);
      setActiveConvId(newConv.id);
      setCurrentConversation(newConv);
      setMessages([newMsg]);
      setCurrentView('chat');
    } catch (err) {
      console.error('Failed to create new thread with search:', err);
      alert('Failed to create thread: ' + err.message);
    }
  };

  const handleSummarizeUrlToThread = async (url) => {
    let convId = activeConvId;
    let targetConv = currentConversation;

    try {
      // 1. If no active conversation exists, create a new one
      if (!convId) {
        let domain = url;
        try { domain = new URL(url).hostname.replace('www.', ''); } catch (e) {}
        const newConv = await api.createConversation({
          title: `Summary: ${domain}`,
          provider: 'gemini',
          model: 'gemini-3.6-flash'
        });
        convId = newConv.id;
        targetConv = newConv;
        setConversations([newConv, ...conversations]);
        setActiveConvId(newConv.id);
        setCurrentConversation(newConv);
      }

      // Switch view to chat immediately so user sees the progress
      setCurrentView('chat');

      // 2. Post user request message into thread
      const userPromptText = `Please provide an AI summary of this page: ${url}`;
      const userMsg = await api.addMessage({
        conversationId: convId,
        role: 'user',
        content: userPromptText,
        provider: 'gemini',
        model: 'gemini-3.6-flash'
      });

      // Temporary placeholder for assistant response while generating
      const tempAssistantId = 'temp-summary-' + Date.now();
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: tempAssistantId,
          role: 'assistant',
          content: `⏳ Analyzing & synthesizing summary for ${url}...`,
          provider: 'gemini',
          model: 'gemini-3.6-flash',
          timestamp: new Date().toISOString()
        }
      ]);

      // 3. Request URL summary from backend
      const res = await api.summarizeURL({ url, model: 'gemini-3.6-flash' });

      let assistantContent = res.summary;
      if (res.title && !assistantContent.includes(res.title)) {
        assistantContent = `### ${res.title}\n\n${assistantContent}`;
      }

      // 4. Save assistant response into database
      const assistantMsg = await api.addMessage({
        conversationId: convId,
        role: 'assistant',
        content: assistantContent,
        provider: 'gemini',
        model: 'gemini-3.6-flash'
      });

      // Replace placeholder with final message
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
        onOpenGoogleSearch={() => setIsGoogleSearchOpen(true)}
      />

      {/* Main Active View */}
      <main className="main-content">
        {currentView === 'chat' && (
          <ChatView 
            activeConvId={activeConvId}
            conversation={currentConversation}
            messages={messages}
            onSendMessage={handleSendMessage}
            onStopStreaming={handleStopStreaming}
            isStreaming={isStreaming}
            streamingText={streamingText}
            providerHealth={providerHealth}
            selectedProvider={selectedProvider}
            setSelectedProvider={setSelectedProvider}
            selectedModel={selectedModel}
            setSelectedModel={setSelectedModel}
            categories={categories}
            onOpenGoogleSearch={() => setIsGoogleSearchOpen(true)}
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
      </main>

      {/* Settings Modal */}
      <SettingsModal 
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onSaved={loadHealth}
      />

      {/* Google Search AI Modal */}
      <GoogleSearchModal 
        isOpen={isGoogleSearchOpen}
        onClose={() => setIsGoogleSearchOpen(false)}
        activeConvId={activeConvId}
        onInsertIntoComposer={handleInsertIntoComposer}
        onPostToThread={handlePostGoogleSearchToThread}
        onNewThreadWithContent={handleNewThreadWithGoogleSearch}
        onSummarizeUrl={handleSummarizeUrlToThread}
      />
    </div>
  );
}
