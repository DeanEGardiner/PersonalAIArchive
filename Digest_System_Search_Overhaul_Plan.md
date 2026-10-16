# Architectural Plan: AI Search-First Digest Overhaul

## 1. Executive Summary & Goals

The current digest system was built as a human-facing journal: it groups historical chat messages into arbitrary broad buckets ("Software Architecture", "Health & Nutrition") and generates prose paragraphs intended for human reading. This design has three critical shortcomings for automated retrieval:
1. **No Granular Provenance**: Summaries mention general discussion topics but do not link to the specific conversation IDs or note paths where the facts live.
2. **Missing Obsidian Vault**: The summarizer only processes `messages` from AI chats; Obsidian notes are completely excluded from the digest pipeline.
3. **Ineffective Retrieval Structure**: Broad category prose dilutes keyword density and lacks the high-entropy entity indexing needed for fast semantic and lexical retrieval.

### Core Objectives
* **AI-First Semantic Indexing**: Shift digests from human-recollection prose to an entity-dense, decision-oriented **Search Map**.
* **Direct Provenance Links**: Every summary item explicitly links to the conversation IDs or Obsidian note paths it indexes (`[Conversation: "<Title>"](id:<conv_id>)` and `[Obsidian Note: "<Title>"](path:<rel_path>)`).
* **Dual-Corpus Digests**: Maintain two dedicated, independent summary streams:
  1. 🤖 **AI Conversations Index** (chat history, web search analyses, code solutions).
  2. 📓 **Obsidian Vault Index** (daily journals, project logs, meeting notes, personal docs).
* **Retire the Categorization System**: Completely deprecate the `categories` table and category tagging. Replace it with direct thread/note cluster indexing and chronological rolling scopes.

---

## 2. Proposed Architecture & Data Flow

```
                 ┌────────────────────────────────────────────────────────┐
                 │                 Dual Source Ingestion                  │
                 └───────────────────────────┬────────────────────────────┘
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     ▼                                               ▼
         ┌────────────────────────┐                     ┌────────────────────────┐
         │ AI Conversation Chats  │                     │  Obsidian Vault Notes  │
         │  (messages & threads)  │                     │   (markdown files)     │
         └───────────┬────────────┘                     └───────────┬────────────┘
                     │                                               │
                     ▼                                               ▼
         ┌────────────────────────┐                     ┌────────────────────────┐
         │ Conversation Digest    │                     │ Obsidian Vault Digest  │
         │ Extraction Engine      │                     │ Extraction Engine      │
         └───────────┬────────────┘                     └───────────┬────────────┘
                     │                                               │
                     ▼                                               ▼
         ┌───────────────────────────────────────────────────────────────────────┐
         │               Structured Search-Optimized Digest Record               │
         │  • Scope: 'ai_conversations' | 'obsidian_notes'                       │
         │  • Semantic Digest: Topics, facts, answers, decisions                 │
         │  • Entity & Keyword Index: Tech, people, dates, terms, part numbers   │
         │  • Provenance Links: [{ id, title, type: 'conversation'|'note' }]     │
         └───────────────────────────────────┬───────────────────────────────────┘
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     ▼                                               ▼
         ┌────────────────────────┐                     ┌────────────────────────┐
         │  SQLite FTS5 + Vectors │                     │ Interactive UI View    │
         │  (archive_summaries_fts│                     │ (Clickable provenance  │
         │  & summary_embeddings) │                     │  links into Chat/Note) │
         └───────────┬────────────┘                     └────────────────────────┘
                     │
                     ▼
    ═══════════════════════════════════════════════════════════════════════════
     TIER-1 SEARCH RESOLUTION:
     Query matches Digest ──> Extracts linked conversation IDs & note paths
                          ──> Guarantees precision retrieval in Tier 2
    ═══════════════════════════════════════════════════════════════════════════
```

---

## 3. Database Schema Evolution (Scrapping Categories)

### Migration #6: Transition to Dual-Corpus Linked Digests
In [`server/db.js`](file:///Users/deangardiner/PersonalAIArchive/server/db.js):

```sql
-- 1. Create the new search-first summaries schema
CREATE TABLE IF NOT EXISTS archive_digests (
  id TEXT PRIMARY KEY,
  corpus_type TEXT NOT NULL,         -- 'ai_conversations' | 'obsidian_notes' | 'unified'
  title TEXT NOT NULL,               -- e.g. "AI Discussions: Oct 2026" or "Obsidian Work Logs"
  summary_text TEXT NOT NULL,        -- Information-dense summary designed for search
  entities_json TEXT DEFAULT '[]',   -- JSON array of keywords, people, tools, concepts
  references_json TEXT DEFAULT '[]', -- JSON array: [{ id, title, rel_path, type }]
  coverage_start TIMESTAMP,
  coverage_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_deleted INTEGER DEFAULT 0
);

-- 2. External-Content FTS5 Table for Instant Lexical Matching
CREATE VIRTUAL TABLE IF NOT EXISTS archive_digests_fts USING fts5(
  title,
  summary_text,
  entities_json,
  content='archive_digests',
  content_rowid='rowid'
);

-- 3. Automated Sync Triggers for FTS5
CREATE TRIGGER IF NOT EXISTS digests_fts_ai AFTER INSERT ON archive_digests BEGIN
  INSERT INTO archive_digests_fts(rowid, title, summary_text, entities_json)
  VALUES (new.rowid, new.title, new.summary_text, new.entities_json);
END;
CREATE TRIGGER IF NOT EXISTS digests_fts_ad AFTER DELETE ON archive_digests BEGIN
  INSERT INTO archive_digests_fts(archive_digests_fts, rowid, title, summary_text, entities_json)
  VALUES ('delete', old.rowid, old.title, old.summary_text, old.entities_json);
END;
CREATE TRIGGER IF NOT EXISTS digests_fts_au AFTER UPDATE ON archive_digests BEGIN
  INSERT INTO archive_digests_fts(archive_digests_fts, rowid, title, summary_text, entities_json)
  VALUES ('delete', old.rowid, old.title, old.summary_text, old.entities_json);
  INSERT INTO archive_digests_fts(rowid, title, summary_text, entities_json)
  VALUES (new.rowid, new.title, new.summary_text, new.entities_json);
END;

-- 4. Dedicated Vector Table for Digests
CREATE TABLE IF NOT EXISTS digest_embeddings (
  digest_id TEXT PRIMARY KEY REFERENCES archive_digests(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

> [!NOTE]
> The legacy `categories` and `archive_summaries` tables will be retired cleanly without dropping historical conversation data.

---

## 4. Search-Optimized Digest Structure & Prompts

### Human Recollection Format (Old ❌)
```markdown
Software Architecture:
In this category, the user discussed building applications. Several key recommendations
were made regarding database selection and API limits. Key recommendation: use SQLite.
```
*Why this fails for search:* No conversation IDs, low entity density, overly abstract.

### AI Search Index Format (New ✅)
```markdown
# AI Conversations Digest: Systems & Infrastructure [2026-10-01 to 2026-10-14]

### Key Problem Solved & Topics:
- Hybrid search architecture with SQLite FTS5 BM25 and local vector embeddings.
- Port binding conflicts on macOS (migrated server from :3002 to :3003).
- Electron arm64 native dependency compilation for better-sqlite3.

### Entity Index:
- Tech: SQLite, FTS5, better-sqlite3, Electron 41.7.1, Vite, React 19, nomic-embed-text-v1.5, Ollama, LM Studio.
- Concepts: Reciprocal Rank Fusion (RRF), O(1) context budgeting, SIMD vector dot-product.

### Direct Provenance References:
- [[Conversation: "can you start the app on free ports"]](id:8b2a-...) -> Resolved port collision, added dynamic Vite proxy.
- [[Conversation: "hybrid search scalability roadmap"]](id:4c9f-...) -> Designed two-tier coarse-to-fine search architecture.
```

### Prompt Engineering for Summarizer (`server/summarizer.js`)
Instead of asking for general categories, the prompt will instruct the model:
1. **Analyze input entries** (either AI conversation turns or Obsidian notes).
2. **Extract discrete topical units**, each with:
   - `title`: Specific thematic title.
   - `core_facts`: Concrete decisions, numbers, code patterns, answers provided.
   - `entities`: Array of exact proper nouns, technologies, names, part numbers, locations.
   - `source_links`: Explicit mappings back to the source IDs/paths passed in the prompt.
3. Output strictly formatted JSON matching this schema for deterministic parsing.

---

## 5. Dual-Corpus Pipeline Implementation

### Pipeline A: AI Conversations Digest (`summarizeConversations`)
* **Input**: Batches of un-summarized conversation messages grouped chronologically or by thread.
* **Output**: Writes to `archive_digests` with `corpus_type = 'ai_conversations'`.
* **Linked Targets**: Array of `{ id: conv.id, title: conv.title, type: 'conversation' }`.

### Pipeline B: Obsidian Vault Digest (`summarizeObsidianVault`)
* **Input**: Un-summarized markdown notes from `obsidian_notes` (reading `title`, `rel_path`, and `content`).
* **Output**: Writes to `archive_digests` with `corpus_type = 'obsidian_notes'`.
* **Linked Targets**: Array of `{ id: note.id, title: note.title, rel_path: note.rel_path, type: 'obsidian_note' }`.

### Pipeline C: Periodic / Incremental Execution
* Supports independent triggering:
  - Generate AI Chat Digest (incremental or full).
  - Generate Obsidian Vault Digest (incremental or full).
* Automatically registers all generated digests into [`server/embeddingService.js`](file:///Users/deangardiner/PersonalAIArchive/server/embeddingService.js) for vector embedding.

---

## 6. Two-Tier Retrieval Integration (`server/hybridSearch.js`)

The new digest structure will transform how [`hybridSearch.assembleContext()`](file:///Users/deangardiner/PersonalAIArchive/server/hybridSearch.js) works:

1. **Tier 1 (Digest Search)**:
   * Query is matched against `archive_digests` using hybrid search (FTS5 + vector).
   * Top matching digests are identified.
   * **Crucial Step**: The engine reads `references_json` from the winning digests, giving a curated list of **exact conversation IDs and note IDs** directly relevant to the query.
2. **Tier 2 (Scoped Evidence Extraction)**:
   * Instead of searching the entire database of 100,000 raw messages, Tier 2 prioritizes queries against the specific conversations and notes linked by the Tier 1 digests.
   * If Tier 1 found an Obsidian digest pointing to `Notes/Talal Rad.md`, Tier 2 immediately loads that exact note without guessing.
3. **Context Packing**:
   * Injects the matched digest summary for high-level orientation.
   * Injects the linked conversation and note excerpts.

---

## 7. UI & Client Overhaul

### [`client/src/components/SummaryView.jsx`](file:///Users/deangardiner/PersonalAIArchive/client/src/components/SummaryView.jsx)
1. **Remove Category Section**: Remove the "Extracted Knowledge Topics" pills and category cards.
2. **Dual-Corpus Tabs**:
   - Tab 1: 🤖 **AI Conversations Digest** (shows search-indexed summaries of your AI chats with links).
   - Tab 2: 📓 **Obsidian Vault Digest** (shows search-indexed summaries of your Obsidian notes with links).
3. **Clickable Provenance Links**:
   - Clicking a conversation link jumps to `ChatView` and opens that thread.
   - Clicking an Obsidian note link jumps to `ObsidianNotesView` and highlights that note.
4. **Targeted Generation Controls**:
   - Two distinct generation actions: *"Digest AI Chats"* and *"Digest Obsidian Notes"*, with independent provider/model selectors.

### [`client/src/api.js`](file:///Users/deangardiner/PersonalAIArchive/client/src/api.js) & [`server/index.js`](file:///Users/deangardiner/PersonalAIArchive/server/index.js)
* Deprecate `/api/categories`.
* Update `/api/summaries` to accept `?corpus=ai_conversations` or `?corpus=obsidian_notes`.
* Update `/api/summaries/generate` to accept `targetCorpus: 'ai_conversations' | 'obsidian_notes' | 'all'`.

---

## 8. Step-by-Step Implementation Roadmap

```
Step 1: Database Migration (#6 in server/db.js)
  └── Create archive_digests, archive_digests_fts, and digest_embeddings.

Step 2: Dual Summarizer Engine (server/summarizer.js)
  ├── Implement search-first prompt with entity and provenance schemas.
  ├── Implement summarizeConversations() for AI chats.
  └── Implement summarizeObsidianVault() for synced Obsidian notes.

Step 3: Background Embedding Support (server/embeddingService.js)
  └── Add queueDigest() and backfill support for archive_digests.

Step 4: Two-Tier Search Wiring (server/hybridSearch.js & server/index.js)
  ├── Update Tier 1 to search archive_digests.
  └── Use references_json to scope Tier 2 candidate resolution.

Step 5: Frontend UI Redesign (client/src/components/SummaryView.jsx)
  ├── Remove category pills and legacy category cards.
  ├── Add Dual-Corpus Tabs (AI Conversations vs Obsidian Notes).
  └── Render interactive provenance links to threads and notes.

Step 6: Verification & End-to-End Test
  ├── Generate sample digests for both AI chats and Obsidian notes.
  ├── Test Tier-1 -> Tier-2 provenance resolution on real queries.
  └── Confirm zero errors in client build and local dev server.
```
