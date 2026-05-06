-- ============================================================================
-- 001_initial.sql — anydocs-ask v1 initial schema
-- ============================================================================
-- Mirrors ARCHITECTURE.md §4 (multilingual revision, 2026-05-06).
-- Any change to this file's semantics MUST be reflected in ARCHITECTURE.md
-- and bumped via a new migration file (002_*, 003_*, ...).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Structure layer (§2.2): refreshed on every drag/metadata edit; never holds
-- embeddings. Composite primary key (page_id, lang) — anydocs allows the same
-- page id under different languages (pages/zh/foo.json and pages/en/foo.json).
-- ---------------------------------------------------------------------------
CREATE TABLE pages (
  page_id      TEXT NOT NULL,
  lang         TEXT NOT NULL,
  status       TEXT NOT NULL,             -- only 'published' rows reach this table
  title        TEXT NOT NULL,
  slug         TEXT,
  breadcrumb   TEXT NOT NULL,             -- JSON: [{id, title, type}, ...] incl. self
  nav_index    INTEGER,                   -- DFS preorder rank within {lang}'s navigation
  parent_id    TEXT,                      -- stable nav id of parent nav node (NOT page_id)
  subtree_root TEXT,                      -- stable nav id of depth-1 ancestor (§2.2.1)
  url          TEXT,                      -- Reader URL (with anchor when available)
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (page_id, lang)
);

CREATE INDEX idx_pages_subtree ON pages(subtree_root);
CREATE INDEX idx_pages_parent  ON pages(parent_id);
CREATE INDEX idx_pages_lang    ON pages(lang);

-- ---------------------------------------------------------------------------
-- Content layer (§2.1): chunks decoupled from pages so structural edits don't
-- touch them. content_hash is the cache key for embedding_cache.
-- ---------------------------------------------------------------------------
CREATE TABLE chunks (
  chunk_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       TEXT NOT NULL,
  lang          TEXT NOT NULL,
  in_page_path  TEXT,                     -- e.g. "h2#auth/p[2]"
  text          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,            -- sha256(normalize(text)) — see ARCH §7.1.2
  token_count   INTEGER NOT NULL,
  is_code       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (page_id, lang) REFERENCES pages(page_id, lang) ON DELETE CASCADE
);

CREATE INDEX idx_chunks_page ON chunks(page_id, lang);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);
CREATE INDEX idx_chunks_lang ON chunks(lang);

-- ---------------------------------------------------------------------------
-- BM25 inverted index (FTS5, external-content form). Keeps text in chunks and
-- only stores the index here; we sync via triggers below so callers can stay
-- naive about FTS internals.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content=chunks,
  content_rowid=chunk_id,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
END;

CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.chunk_id, old.text);
END;

CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.chunk_id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.chunk_id, new.text);
END;

-- ---------------------------------------------------------------------------
-- Vector index (sqlite-vec). Default dim 1024 = bge-m3. Switching embedding
-- model means re-running the rebuild flow (ARCH §4.1) which drops + recreates
-- this table at the new dim — handled in code, not in this migration.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[1024]
);

-- ---------------------------------------------------------------------------
-- Embedding cache — the heart of "drag = zero re-embed" (PRD §4.6).
-- Composite PK lets us keep multiple models' vectors for the same text so
-- model swaps don't force a destructive purge.
-- ---------------------------------------------------------------------------
CREATE TABLE embedding_cache (
  content_hash TEXT NOT NULL,
  model        TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (content_hash, model)
);

-- ---------------------------------------------------------------------------
-- Feedback pool (v1 must capture; consumers in v1.5+).
-- ---------------------------------------------------------------------------
CREATE TABLE feedback (
  feedback_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id        TEXT NOT NULL,
  question         TEXT NOT NULL,
  current_page_id  TEXT,
  retrieved        TEXT,                  -- JSON: [{chunk_id, page_id, score}, ...]
  generated        TEXT NOT NULL,
  rating           INTEGER,               -- +1 / -1
  correction       TEXT,
  bad_citation_ids TEXT,                  -- JSON: ["cit_2", ...]
  tags             TEXT,                  -- JSON
  model_used       TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_feedback_answer ON feedback(answer_id);
CREATE INDEX idx_feedback_created ON feedback(created_at);

-- ---------------------------------------------------------------------------
-- Answer cache (TTL 24h, opportunistic GC handled in code; ARCH §4.1).
-- ---------------------------------------------------------------------------
CREATE TABLE answers (
  answer_id   TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  payload     TEXT NOT NULL,              -- JSON: full generation context + retrieved
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_answers_created ON answers(created_at);
