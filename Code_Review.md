# Personal AI Archive — Code Review

**Date:** 2026-10-09
**Scope:** `server/` (Express + SQLite) and `client/src/` (React 19 + Vite) at `main` plus the uncommitted Google Search button removals.
**Method:** I read every server module and client component, grepped for dead references, and ran `oxlint` (38 warnings, 0 errors).

---

## 1. Executive Summary

The app works, but it grew one feature at a time and nobody went back to consolidate. Five themes stand out:

1. **Large dead code paths.** The streaming chat pipeline and the Google Search modal can no longer be reached from the UI. Both still exist end to end, from the client state through to the server endpoints.
2. **Logic is copied rather than shared.** Model defaults, API key lookup, markdown export, FTS sync and the Obsidian sync button are each written out 3 to 12 times. Several of the copies have already drifted apart.
3. **Database basics are missing.** There are no indexes, there are N+1 queries, multi-row writes run without transactions, and the FTS tables are synced by hand.
4. **Hot paths are expensive.** A full recursive vault scan runs on every keystroke in two places. Obsidian sync blocks the Node event loop.
5. **Architecture limits growth.** `server/index.js` (1,100 lines) and `App.jsx` (500 lines) do too much. Posts don't carry conversation history, and the summariser sends the whole archive in one prompt.

The review also turned up several **functional bugs** (§5) and **security exposures** (§6). These deserve attention ahead of the refactors.

---

## 2. Redundant / Dead Code

### 2.1 Unreachable streaming chat pipeline — HIGH
[ChatView.jsx `handleSubmit`](file:///Users/deangardiner/PersonalAIArchive/client/src/components/ChatView.jsx#L107-L130) always takes the `onSubmitPost` branch, because `App` always passes that prop. As a result the whole SSE chat stack is dead:

| Location | Dead code |
|---|---|
| [App.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/App.jsx#L145-L243) | `handleSendMessage`, `handleStopStreaming`, `isStreaming`, `streamingText`, `abortControllerRef` |
| [ChatView.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/ChatView.jsx#L379-L399) | Live streaming bubble, Stop button, `onSendMessage` branch |
| [api.js `streamChat`](file:///Users/deangardiner/PersonalAIArchive/client/src/api.js#L59-L120) | SSE reader |
| [index.js `/api/chat`](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L600-L743) | ~145 lines of SSE endpoint |

**Decision needed:** this is the only path that sends **conversation history** to the model. Posts send a single message (see §4.3). You can either **delete it** or **merge streaming into the post flow**. I recommend merging, because it gives you token streaming and multi-turn context.

### 2.2 Orphaned Google Search modal — HIGH
Once the two buttons were removed, nothing sets `isGoogleSearchOpen` to `true`. The following can now be deleted:
- [GoogleSearchModal.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/GoogleSearchModal.jsx) (329 lines)
- In `App.jsx`: `isGoogleSearchOpen`, `handlePostGoogleSearchToThread`, `handleNewThreadWithGoogleSearch`, the `<GoogleSearchModal>` mount, and the `onOpenGoogleSearch` prop passed to `Sidebar`
- [Sidebar.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/Sidebar.jsx#L23): the unused `onOpenGoogleSearch` prop
- `api.searchGoogleAI` and the server's `POST /api/search/ai`
- In `index.css`: `.btn-google-search-sidebar`, `.google-g-icon`, `.google-search-modal-*`

The "3. Google Cloud Search" submission mode still covers this feature.

### 2.3 Unused files and assets — LOW
- [App.css](file:///Users/deangardiner/PersonalAIArchive/client/src/App.css) (184 lines) is never imported. It is leftover Vite template code.
- `client/src/assets/react.svg`, `vite.svg` and `client/public/icons.svg` are never referenced.
- `UI_Components_Walkthrough.pdf` (~23k lines) is committed to git. Use Git LFS or generate it at build time.

### 2.4 Unused endpoints and API methods — LOW
- `GET /api/conversations/:id/messages` duplicates `GET /api/conversations/:id`, and the client never calls it.
- `api.getTimeline(limit)` is never called. The server also ignores `limit`.
- `POST /api/conversations/:id/messages` is only used by the URL summariser and the dead Google modal.

### 2.5 Unused schema — LOW
In [db.js](file:///Users/deangardiner/PersonalAIArchive/server/db.js):
- `message_categories` is **never written**, so the export's "tags" and "topics" are always empty.
- `device_id`, `metadata_json` and `attachments.checksum` are never read or written.
- Either implement category tagging in the summariser or drop these columns.

### 2.6 Unused imports and variables — LOW
`oxlint` reports 38 warnings. Examples:
- `ChatView`: `ChevronDown`, `Info`, `Tag`, `activeConvId`
- `ArchiveView`, `SummaryView`, `ObsidianNotesView`: many unused lucide icons

Add `npm run lint` to a pre-commit hook.

---

## 3. Duplicated Logic

| Concern | Copies | Where |
|---|---|---|
| **Default model names** (`gemini-3.6-flash` vs `gemini-3.8-flash`, `gemma4:12b-mlx`, `qwen/qwen3.8-27b`, …) | ~25 literals | `index.js`, `providers.js`, `summarizer.js`, `App.jsx`, `ChatView.jsx`, `SummaryView.jsx`, `api.js`, `db.js` |
| **API key resolution** (`settings` table → `process.env`) | 7 | `index.js` ×4, `providers.js`, `summarizer.js` |
| **Ollama/LM Studio URL lookup** from settings | 3 | `providers.js` `checkHealth`, `streamChat`, `analyzeArchiveKnowledge` |
| **Message INSERT + `messages_fts` INSERT** | 6 | `index.js` |
| **Conversation auto-title** (`slice(0,40)+'...'`, "New Conversation" check) | 3 | `index.js` ×2, `App.jsx` |
| **Markdown generation** for conversations and summaries | 3 (different formats) | `/api/export/markdown`, `obsidianSync.sync`, `summarizer.js` |
| **Filename sanitising** | 4 (different regexes) | same as above |
| **`handleSyncObsidian`** + feedback state | 3 | `ArchiveView`, `SummaryView`, `ObsidianNotesView` |
| **Archive-analysis system prompt** | 2 identical | `providers.js` Ollama and LM Studio branches |
| **Image → base64 loop** | 4 | `providers.js` |
| **`fetch` + `res.ok` + error JSON** boilerplate | ~25 | `api.js` |
| **Hardcoded vault path** `/Users/deangardiner/Documents/DeanGVault` | 3 | `db.js`, `obsidianSync.js`, `SettingsModal.jsx` |

**Recommendations**
- Create `server/config.js`. It should export `DEFAULT_MODELS`, `getSetting(key)` and `getApiKey(provider)`, and expose models to the client through `/api/health`. Then delete every client-side model list.
- Create `server/repo/messages.js` with `insertMessage({...})`. It should write the row and the FTS entry in one transaction.
- Create `server/markdown.js` with `conversationToMarkdown()`, `summaryToMarkdown()` and `safeFilename()`. The zip export, the vault sync and the summariser should all use it.
- Add a client `request(path, opts)` helper to `api.js` (about 60% fewer lines), plus a `useObsidianSync()` hook.

---

## 4. Limiting Architecture

### 4.1 Monolithic server entry — MEDIUM
`server/index.js` mixes routing, validation, retrieval (RAG), prompt assembly, persistence and export. The `/posts` handler alone is 315 lines.

**Recommended split:**
```
server/
  app.js              (express setup, middleware, error handler)
  config.js
  routes/  conversations.js  posts.js  archive.js  summaries.js  obsidian.js  export.js  settings.js
  services/ retrieval.js (FTS + Obsidian context builder)  markdown.js
  repo/    messages.js  conversations.js
  providers/ index.js  gemini.js  openai.js  ollama.js  lmstudio.js
```

### 4.2 Provider router is one `if/else` class with mutable singleton state — MEDIUM
- [providers.js](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L143-L161) changes `this.ollamaBaseUrl` on every call. The value is shared global state.
- There are 3 different call shapes for local models: `streamOllama` uses `/api/chat`, `analyzeArchiveKnowledge` uses `/api/generate`, and LM Studio uses the OpenAI SDK in one method and raw `fetch` in another.
- `require()` is called inside methods.
- **Recommendation:** use a common interface, `{ stream(messages, opts), complete(messages, opts), listModels() }`, with one adapter per provider. `analyzeArchiveKnowledge` and `googleSearchAI` then become prompt builders that call `complete()`. LM Studio is OpenAI-compatible, so it can reuse the OpenAI adapter with a different `baseURL`.

### 4.3 Posts ignore conversation history — HIGH (product-level)
`ai_analysis` sends only the current post plus retrieved snippets, so follow-up questions ("what about the second one?") have no context. Add the last *N* turns to the prompt. This pairs with merging streaming (§2.1).

### 4.4 Retrieval is keyword-only with a hand-made stop-word list — MEDIUM
[index.js](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L272-L312) uses a stop-word list built around phrases like "can you scan the local archive", tries an AND query, then falls back to OR, and sorts by **timestamp, not relevance**.
- Use `ORDER BY bm25(messages_fts)` (or `rank`).
- Move retrieval into `services/retrieval.js`.
- Your existing [Hybrid Search Roadmap](file:///Users/deangardiner/PersonalAIArchive/Archive_Scalability_and_Hybrid_Search_Roadmap.md) (sqlite-vec embeddings) needs this module boundary first.

### 4.5 Summariser can't scale — HIGH
[summarizer.js](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js#L113-L141) puts **every message** (each truncated to 500 chars) into a single prompt. "Full re-run" will exceed the context window once the archive is a few thousand messages.
- **Map-reduce:** summarise per conversation or per time window, then summarise those summaries.
- Every run **appends** new `archive_summaries` rows, and old ones are never pruned. Upsert per category or keep N versions.
- File writes happen **inside** `db.transaction`. If the transaction rolls back, the files stay on disk. Write files after commit.

### 4.6 FTS tables maintained by hand — MEDIUM
`messages_fts` and `obsidian_notes_fts` store a full second copy of the content, and the app keeps them in sync manually:
- Deletes never remove FTS rows, so the index grows forever.
- Any new insert path that forgets the FTS line silently drops that message from search.

**Fix:** use external-content FTS5 (`content='messages', content_rowid='rowid'`) with `AFTER INSERT/UPDATE/DELETE` triggers.

### 4.7 Schema migrations — LOW
Migrations are currently `try { ALTER TABLE … } catch {}`. Add a `schema_version` table (or `PRAGMA user_version`) and run ordered migrations.

### 4.8 Client state is a god component with prop drilling — MEDIUM
`App.jsx` owns all state and passes up to 16 props into `ChatView`.
- Introduce a `ChatContext` or a small store such as Zustand.
- Extract `useConversations()`, `useProviderHealth()` and `usePostSubmit()`.
- Move views to URL routes so the back button and deep links work.

### 4.9 Inline styles over the design system — LOW
`ChatView`, `ObsidianNotesView` and `SettingsModal` contain hundreds of lines of `style={{…}}`, even though `index.css` defines tokens. The mode buttons, the processing card and the attachment chip should become CSS classes. That reduces JSX noise and allows `:hover` and `:focus-visible` states.

### 4.10 Markdown renderer is too limited — MEDIUM
[FormattedText.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/FormattedText.jsx) handles links, bold and inline code only. The prompts explicitly ask models for **headings, bullet lists and code blocks**, so these appear as raw `###` and ```` ``` ````. Use `react-markdown` + `remark-gfm` with a custom `a` component that keeps the "AI summary" hover feature.

### 4.11 Eager empty conversations — LOW
The "New Conversation" button creates a DB row right away, but `/api/posts` already creates conversations lazily. This leaves empty threads behind. `handleStartChatWithNote` also calls `handleNewConversation()` without `await`. Make "New" a client-only draft state.

---

## 5. Inefficient Code and Bugs

### 5.1 Performance

| # | Issue | Location | Fix |
|---|---|---|---|
| P1 | **No indexes** on `messages(conversation_id, timestamp)`, `messages(timestamp)`, `attachments(message_id)` or `conversations(updated_at)`. Every conversation load, list and summariser query does a full scan. | [db.js](file:///Users/deangardiner/PersonalAIArchive/server/db.js) | `CREATE INDEX IF NOT EXISTS …` |
| P2 | **Full recursive vault scan on every keystroke.** `SettingsModal` writes the vault path and calls `getStatus()` on each key press. `ObsidianNotesView.handleSearch` calls `getObsidianStatus()` and fetches notes on each key press. `getStatus` → `validateVault` → `findMarkdownFiles` walks the whole vault. | [SettingsModal.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/SettingsModal.jsx#L166-L169), [ObsidianNotesView.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/ObsidianNotesView.jsx#L52-L56), [obsidianSync.js](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L385-L400) | Debounce input. Validate on blur or save only. Return the DB count in status, or cache the disk count. Don't refetch status during search. |
| P3 | **N+1 attachment queries.** One query per message, and the statement is re-prepared each loop. | [index.js](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L136-L140) | One query with `WHERE message_id IN (…)` or a `LEFT JOIN`, then group in JS |
| P4 | **Obsidian sync blocks the event loop and runs without a transaction.** It uses sync `fs` and reads plus SHA-256 hashes **every** file even when `mtime` is unchanged. Each insert autocommits. | [obsidianSync.js](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L151-L192) | Skip when `mtime`+`size` match. Wrap DB work in `db.transaction`. Use `fs.promises`. |
| P5 | **Sync re-renders all conversations** to compare against disk each time. | [obsidianSync.js](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L209-L262) | Only export conversations whose `updated_at` is later than `obsidian_last_sync` |
| P6 | **Statements re-prepared per request.** `db.prepare()` runs inside handlers everywhere. | server-wide | Prepare once at module load |
| P7 | **Conversation list correlated subqueries** (count + last message) on every list load. The client also calls `loadConversations()` after every post. | [index.js](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L92-L102) | Indexes (P1). Return the updated conversation from `/posts` and patch client state. |
| P8 | **Double fetch after a post.** `selectConversation()` then `loadConversations()`. The latter captures a stale `activeConvId` and can trigger a third fetch. | [App.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/App.jsx#L61-L71) | Use the `/posts` response directly |
| P9 | **The whole message list re-renders on every keystroke.** `inputText` lives in `ChatView`, and the source-citation regex parsing runs inside `map` on every render. | [ChatView.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/ChatView.jsx#L235-L258) | Extract a `<Composer>` and a memoised `<MessageItem>`. Parse sources server-side or with `useMemo`. |
| P10 | `/api/health` calls the Gemini model-list API on every load (2s timeout). | [providers.js](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L101-L117) | Cache for ~10 minutes |

### 5.2 Functional bugs

| # | Bug | Location |
|---|---|---|
| B1 | **OpenAI archive analysis ignores the saved key.** It calls `getOpenAIClient()` with no key, so it only works through `.env`. `/posts` also passes the *Gemini* key as `apiKey` for every provider. | [providers.js L546](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L546), [index.js L266-L267](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L266-L267) |
| B2 | **Ollama stream drops tokens.** Each network chunk is split on `\n` with no carry-over buffer, so a JSON line split across two chunks is discarded silently. | [providers.js L279-L294](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L279-L294) |
| B3 | **Images are broken in dev.** The Vite proxy forwards `/api` and `/summaries-files` but not `/media`. | [vite.config.js](file:///Users/deangardiner/PersonalAIArchive/client/vite.config.js) |
| B4 | **Archive provider filter never matches.** It compares `c.provider`, but rows only have `default_provider`. | [ArchiveView.jsx L64](file:///Users/deangardiner/PersonalAIArchive/client/src/components/ArchiveView.jsx#L64) |
| B5 | **The "only private AI summarisation" setting is bypassed.** `overrideProvider` from the UI takes priority over `config.provider`, so cloud providers can still be used. | [summarizer.js L47](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js#L47) |
| B6 | **Gemini stream can't actually be aborted.** The `abortSignal` isn't passed to the SDK; the loop only `break`s on the next chunk. | [providers.js L183-L195](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L183-L195) |
| B7 | **Renamed or deleted conversations leave stale vault files.** The filename includes the title, and old files are never removed. | [obsidianSync.js L220](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L220) |
| B8 | **Error messages never reach FTS** (fine), but the 5 other message inserts in `/posts` aren't in a transaction. A crash in the middle can leave a user post without its FTS row. | [index.js L206-L234](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L206-L234) |
| B9 | `ensureGeminiModel` silently replaces a non-Gemini model with `gemini-3.8-flash`, while other paths default to `3.6`. The model shown on a message can differ from the one selected. | [providers.js L356-L361](file:///Users/deangardiner/PersonalAIArchive/server/providers.js#L356-L361) |

---

## 6. Security (local app, but still exposed)

| # | Issue | Fix |
|---|---|---|
| S1 | `app.use(cors())` allows **any origin**, and `app.listen(PORT)` binds to **all interfaces**. Any website you visit, or any device on your LAN, can call the API. | `app.listen(PORT, '127.0.0.1')`; restrict CORS to `http://localhost:5173` |
| S2 | `GET /api/settings` returns API keys in plaintext to the browser. Combined with S1, any site can read them. | Return masked values (`sk-…abcd`) and only accept writes |
| S3 | `POST /api/obsidian/vault-path` + `/sync` will create an `AI Archive/` folder and write files to **any directory** the request names. | Validate against an allow-list, or require confirmation |
| S4 | Uploads accept any file type; the extension comes from user input. | Allow image MIME types only (multer `fileFilter`) |
| S5 | The Gemini key is sent in the URL query string (`?key=`) for model listing, which ends up in logs. | Use the `x-goog-api-key` header |

---

## 7. Prioritised Action Plan

| Priority | Action | Effort |
|---|---|---|
| **P0** | S1, S2: bind to localhost, tighten CORS, mask keys | 30 min |
| **P0** | B1, B2, B3, B4: OpenAI key, Ollama buffer, `/media` proxy, archive filter | 1 hr |
| **P0** | P1: add DB indexes | 15 min |
| **P1** | P2: stop the per-keystroke vault scans (debounce, validate on save) | 30 min |
| **P1** | §2.1 / §4.3: decide on streaming; merge it into posts with conversation history, or delete it | 3–4 hrs |
| **P1** | §2.2, §2.3: delete the Google modal, `App.css`, template assets, unused endpoints | 30 min |
| **P1** | §3: `config.js` (models, keys), `insertMessage()` with transaction, shared `markdown.js` | 2–3 hrs |
| **P2** | P3, P4, P5: N+1 fix; Obsidian sync incremental + transactional + async | 2 hrs |
| **P2** | §4.6: external-content FTS with triggers | 1–2 hrs |
| **P2** | §4.10: `react-markdown` | 1 hr |
| **P2** | §4.5: map-reduce summariser + summary upsert | 3–4 hrs |
| **P3** | §4.1, §4.2, §4.8: split `index.js`, provider adapters, client hooks and context | 1–2 days |
| **P3** | §4.9: move inline styles to CSS classes; fix lint warnings | 2–3 hrs |
