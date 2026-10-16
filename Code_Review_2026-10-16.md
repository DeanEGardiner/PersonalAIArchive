# Personal AI Archive — Code Review (Search Overhaul & Model Lock)

**Date:** 2026-10-16
**Scope:** All uncommitted changes on `main` (13 files, +2,003 / −636): the dual-corpus digest system, atomic note chunking and entity index (Migrations 6–7), hybrid search changes, the redesigned Digest tab, and the conversation model-lock fix.
**Method:** Read the full `git diff` for `server/`, `electron/` and `client/src/`, cross-checked against the live database, and ran `oxlint` (66 warnings, 0 errors).
**Previous review:** [Code_Review.md](./Code_Review.md) (2026-10-09). It is still valid for anything not covered here.

---

## 1. Summary

The search pipeline is now much stronger than before. Retrieval runs in tiers (entity index → digests → chunks → messages), FTS5 triggers keep the indexes in sync, and the context is built within a character budget. Most of the problems found are at the **edges**, not in the core design:

- **LLM output is trusted without validation.** Digest entities and references are saved and rendered exactly as the model returns them.
- **Re-indexing creates churn.** Every sync deletes and recreates chunk IDs, so all of their embeddings are thrown away and computed again.
- **The "model lock" is only enforced in the UI.** The server still lets you switch providers mid-conversation, and two features (Google Search mode, URL summary) always use Gemini anyway.
- **Some summarizer modes are wrong.** "Full re-run" doesn't actually cover all history, and an Obsidian "incremental" run with no changes creates duplicate digests.

| Severity | Count |
|---|---|
| 🔴 High | 5 |
| 🟠 Medium | 9 |
| 🟢 Low | 8 |

---

## 2. High Severity

### H1. LM Studio digest generation defaults to an embedding model
[SummaryView.jsx:68](file:///Users/deangardiner/PersonalAIArchive/client/src/components/SummaryView.jsx#L68)

The fallback model for `lmstudio` is set to `text-embedding-nomic-embed-text-v1.5`. When provider health *is* available, the code picks `models[0]` instead. LM Studio currently lists that same embedding model **first** (confirmed via `/api/health`). Either way, choosing LM Studio in the Digest tab picks a model that cannot chat, so generation fails or returns nothing.

**Fix:** Revert the fallback to a chat model (e.g. `qwen/qwen3.8-27b`), and filter `text-embedding-*` / `*embed*` models out of every chat model dropdown (Digest tab and ChatView).

### H2. "Full re-run" deletes all digests but only rebuilds from the oldest 350 messages
[summarizer.js:135](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js#L135) (`summarizeConversations`)

In `full` mode the query is `ORDER BY m.timestamp ASC LIMIT 350`, and the transaction then soft-deletes **every** active AI-conversation digest. With more than 350 messages (you have 171 today, so this will start to matter soon), a full re-run quietly drops coverage of your **most recent** conversations. They stay missing until incremental runs catch up.

The Obsidian full mode has the same problem: `ORDER BY updated_at DESC LIMIT 150`, so notes older than the 150 most recent never get a digest.

**Fix:** In full mode, process in batches (loop 250 messages / 100 notes at a time, each batch producing digests) until everything is covered. Soft-delete the old digests only after all batches succeed.

### H3. Obsidian "incremental" with no changed notes creates duplicate digests
[summarizer.js:326](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js#L326) (`summarizeObsidianVault`, around [line 352](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js#L352))

If no notes changed since the last digest, the code falls back to "the most recent 60 notes" and digests them **again**, without soft-deleting the earlier digests for those notes. Every click on Generate adds another set of near-identical digests. Those duplicates then compete in Tier-1 search and take up context budget.

**Fix:** Return `{ processedCount: 0, message: 'No changed notes' }` like the conversations pipeline does. Or, if a refresh is intended, soft-delete the digests that reference those note IDs first.

### H4. LLM-returned entities and references are not validated
[summarizer.js](file:///Users/deangardiner/PersonalAIArchive/server/summarizer.js) (both pipelines) → [SummaryView.jsx](file:///Users/deangardiner/PersonalAIArchive/client/src/components/SummaryView.jsx) and [hybridSearch.js](file:///Users/deangardiner/PersonalAIArchive/server/hybridSearch.js)

- `entities` is saved as long as it is an array. If a model returns objects (e.g. `{ "name": "SQLite" }`), then `{ent}` in SummaryView throws *"Objects are not valid as a React child"*, `e.toLowerCase()` in the filter throws, and **the whole Digest tab crashes**.
- `references[].id` values are never checked against the database. Hallucinated conversation IDs feed straight into `assembleContext` (`WHERE m.conversation_id IN (...)`), where they match nothing. In the UI, clicking one calls `selectConversation()` with an ID that doesn't exist, leaving the chat view stuck on an invalid `activeConvId`.

**Fix:** Sanitize before inserting:
```js
const entities = (d.entities || [])
  .map(e => typeof e === 'string' ? e : e?.name)
  .filter(e => typeof e === 'string' && e.trim()).map(e => e.trim().slice(0, 80));
const validConv = db.prepare('SELECT 1 FROM conversations WHERE id = ? AND is_deleted = 0');
const references = (d.references || []).filter(r => r && r.id && validConv.get(r.id));
```
(For note references, check against `obsidian_notes` by `id` or `rel_path`.)

### H5. The model lock is only enforced in the client
[index.js:156](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L156) (PATCH), [index.js:284](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L284) (posts)

The fix from 2026-10-14 stops the UI from resetting to Gemini. However, the server still accepts any `provider`/`model` on `POST /posts` and `PATCH`. It even **overwrites** `default_provider` with whatever was sent. Meanwhile, `GET /api/conversations/:id` resets the default back to the *first* user message. So the two endpoints disagree, and any client bug or stale tab can still switch providers mid-thread.

**Fix:** Make the server the source of truth. If the conversation already has messages, ignore (or reject with 409) a `provider`/`model` that differs from the anchor. In PATCH, refuse provider/model changes once messages exist. Also remove the write from the GET handler (see M8).

---

## 3. Medium Severity

### M1. Chunk IDs are recreated on every re-index, so all chunk embeddings are recomputed
[obsidianSync.js:546](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L546) (`processNoteChunksAndEntities`)

Each call deletes every chunk for the note and inserts new ones with fresh `uuidv4()` IDs. The FK cascade deletes their embeddings, and every chunk is queued for embedding again, even when the text hasn't changed. It also runs when only the **mtime** changed (identical checksum, [line 159](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L159)), which happens often with iCloud/Obsidian sync.

**Fix:** In the checksum-identical branch, only re-chunk if `hasChunks` is false. For changed notes, use a deterministic chunk ID (`sha1(noteId + chunkIndex + content)`) and skip re-embedding when that ID already has an embedding.

### M2. Whole-note embeddings go stale after edits
The sync loop no longer calls `queueObsidianNote` (the call was replaced by `processNoteChunksAndEntities`). `backfillBatch` only picks up notes with **no** embedding. So when an existing note is edited, its note-level embedding keeps describing the old content, and `searchObsidianNotes` keeps ranking against it.

**Fix:** In `processNoteChunksAndEntities`, call `queueObsidianNote(noteId, ...)` again, or delete the row from `obsidian_note_embeddings` so backfill picks it up.

### M3. Deleting a note leaves orphaned entities
`archive_entities` has no foreign key (by design, since `source_id` can point to a note or a conversation), and the deletion loop in `syncVault` only deletes from `obsidian_notes`. Orphaned entities would still match in `searchEntities` (the `LEFT JOIN` returns `null` titles) and inject snippets from deleted notes into the context. There are **0 orphans today**, but the first time a note is deleted or renamed in the vault, they will appear.

**Fix:** Add `DELETE FROM archive_entities WHERE source_type='obsidian_note' AND source_id = ?` next to `deleteNoteStmt.run(...)`.

### M4. Duplicate snippets in the assembled context
[hybridSearch.js:597–632](file:///Users/deangardiner/PersonalAIArchive/server/hybridSearch.js#L597-L632)

`searchObsidianNotes` rewrites chunk hits so that `id = note_id`. Entity hits use `id = chunk_id`. The dedupe check (`existingIds.has(ent.id)`) compares note IDs against chunk IDs, so it never matches. As a result, the same chunk can be added once as a search hit and again as an entity hit, using up the Obsidian budget twice.

**Fix:** Dedupe on `chunk_id ?? id` consistently across both lists.

### M5. Google Search mode and URL summaries always use Gemini
- [index.js:418](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L418) → `googleSearchAI` is Gemini-only. The selected **post mode** also persists between messages, so after one search every following reply stays on Gemini until you switch the mode back.
- [App.jsx:338](file:///Users/deangardiner/PersonalAIArchive/client/src/App.jsx#L338) → `summarizeURL` is Gemini-only, but both messages are saved with `provider: selectedProvider` (e.g. `lmstudio`). The archive then records that a local model wrote something Gemini actually wrote.

**Fix:** Reset `postMode` to `standard` (or `ai_analysis`) after a Google Search post. Add a visible "uses Gemini" badge to the button. Save the summary messages with the provider that actually produced them (return `provider`/`model` from `/api/summarize-url`).

### M6. Summarizer prompts can exceed local model context windows
The conversations prompt can be up to 250 × 600 = **150k characters** (~37k tokens). The Obsidian prompt can be up to 100 × 750 = 75k characters. Many LM Studio / Ollama models load with 4k–32k context by default, so the input gets truncated silently and the JSON output comes back cut off or malformed. That shows up as *"Failed to parse … as JSON"*.

**Fix:** Size batches by a character budget (e.g. 24k characters for local providers) instead of a fixed row count, and loop (this also fixes H2).

### M7. Note title is overwritten with the file name
[obsidianSync.js:158](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L158)

`findNoteStmt` selects only `id, checksum, mtime_ms`, so `existing.title` is always `undefined`. In the checksum-identical branch, the title gets reset to `note.fileName`, which throws away the title taken from frontmatter or the H1. The `note_title` entity is then indexed under the wrong name.

**Fix:** Add `title` to the `findNoteStmt` SELECT.

### M8. `GET /api/conversations/:id` writes to the database
[index.js:201](file:///Users/deangardiner/PersonalAIArchive/server/index.js#L201)

A read endpoint that silently writes is surprising. It also conflicts with the POST handler (H5). The one-time repair has already been run, so this logic no longer needs to run on every read.

**Fix:** Move it into a migration (Migration 8: backfill `default_provider/model` from the first user message), then remove it from the GET handler.

### M9. Vector search is a full linear scan on every query
`searchDigests`, `searchObsidianChunks` and `searchObsidianNotes` each `SELECT` **every** embedding BLOB, convert it to a `Float32Array`, and compute cosine similarity, three times per query. That's fine at about 420 chunks, but it grows linearly and allocates heavily. (The comment calling the entity lookup *"O(1) Indexed"* is also inaccurate: `LIKE '%x%'` can't use the index.)

**Fix (when needed):** Cache the decoded vectors in memory (and invalidate them on insert), or adopt `sqlite-vec`. For entities, use exact or prefix matches (`LIKE 'x%'`) so the index is used, or add an FTS5 trigram table, which also gives typo tolerance (see L1).

---

## 4. Low Severity

| # | Finding | Location | Suggestion |
|---|---|---|---|
| L1 | No fuzzy matching for misspelled names (the original "Mataus Asato" problem). Keyword `LIKE` only catches partial overlaps. | `searchEntities` | FTS5 `tokenize='trigram'` on `archive_entities.normalized_name`, or a Levenshtein ≤ 2 pass over candidate entities. |
| L2 | `obsidianSync.js` runs `reindexAllNotes()` synchronously **at require time**, blocking startup on large vaults. | [obsidianSync.js:670](file:///Users/deangardiner/PersonalAIArchive/server/obsidianSync.js#L670) | Move into an explicit `init()` called after the server starts listening, wrapped in `setImmediate`. |
| L3 | `INSERT OR IGNORE` on `archive_entities` never ignores anything (the PK is a fresh UUID). The same entity can repeat across chunks. | `processNoteChunksAndEntities` | Add `UNIQUE(normalized_name, chunk_id)`, or drop `OR IGNORE`. |
| L4 | The chunker's `start_char`/`end_char` drift when paragraph separators aren't exactly `\n\n` (the `+2` assumption). | `chunkNoteContent` | Track offsets with `indexOf` on the original content. |
| L5 | Proper-noun regex picks up sentence-initial words ("The Meeting", "So Then"), which adds noise to the entity index. | `extractEntitiesFromText` | Skip matches at sentence start unless they are 2+ capitalised words and not in a common-word list. |
| L6 | Digest markdown filenames are truncated to 50 characters, so colliding titles overwrite each other. Digests soft-deleted in the DB stay on disk and are **re-exported** in the ZIP. | summarizer + `/api/export/markdown` | Add a short ID suffix to filenames, and delete or move files when digests are soft-deleted. |
| L7 | `targetObsidianNoteId` is never cleared, so every later visit to the Obsidian tab jumps back to that note. | [App.jsx:378](file:///Users/deangardiner/PersonalAIArchive/client/src/App.jsx#L378) | Clear it once ObsidianNotesView has used it. |
| L8 | Dead code: `/api/categories` now returns `[]`, but `App.jsx` still calls `loadCategories()` and holds `categories` state. `getGlobalSummary` matches `title LIKE '%global%'`. | App.jsx, index.js | Remove the categories state/calls, and drop or redefine the global summary endpoint. |

---

## 5. What's Good

- **Migrations are additive and idempotent** (`IF NOT EXISTS`, `WHERE NOT EXISTS` data copy, FTS `rebuild`). `PRAGMA foreign_keys = ON` makes the chunk → embedding cascades work.
- **FTS5 external-content tables with triggers** remove the manual FTS syncing flagged in the previous review.
- **The search keyword sanitiser** (`[^a-z0-9\s]` → space) means FTS `MATCH` strings can't be malformed or injected.
- **Weighted RRF**, plus AND-over-OR fusion for chunks, is a sensible and cheap way to improve ranking.
- **Context budget allocator** keeps prompts bounded no matter how many hits come back.
- **Summarizer writes run in one transaction**, and file writes happen after commit.
- **`cleanAndParseJson`** handles the common ways local models break JSON (`<think>` tags, code fences, trailing commas).

---

## 6. Recommended Order of Work

1. **H1, H4, M7**: small, contained fixes that prevent crashes and bad data (≈1 hour).
2. **H3, M3, M4**: stop duplicates and orphans from building up in the index.
3. **H5 + M8 + M5**: finish the model lock properly on the server, and label the Gemini-only features.
4. **H2 + M6**: rework the summarizer to batch by a character budget (one change fixes both).
5. **M1, M2**: stop re-embedding unchanged content.
6. **M9, L1**: scalability and fuzzy matching once the vault grows.

> [!NOTE]
> There are no automated tests. The changes most worth covering are `chunkNoteContent`, `extractEntitiesFromText`, `cleanAndParseJson` and `combineRRF`. They are pure functions and need no database or network to test.
