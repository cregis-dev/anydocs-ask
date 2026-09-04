-- Structured parent-child retrieval and exact identifier lookup.

CREATE TABLE chunk_parents (
  parent_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id        TEXT NOT NULL,
  lang           TEXT NOT NULL,
  parent_path    TEXT NOT NULL,
  heading_id     TEXT,
  heading_path   TEXT NOT NULL,
  text           TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  token_count    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE(page_id, lang, parent_path),
  FOREIGN KEY (page_id, lang) REFERENCES pages(page_id, lang) ON DELETE CASCADE
);

CREATE INDEX idx_chunk_parents_page ON chunk_parents(page_id, lang);
CREATE INDEX idx_chunk_parents_hash ON chunk_parents(content_hash);

ALTER TABLE chunks ADD COLUMN parent_id INTEGER REFERENCES chunk_parents(parent_id) ON DELETE SET NULL;
ALTER TABLE chunks ADD COLUMN chunk_kind TEXT NOT NULL DEFAULT 'content';
ALTER TABLE chunks ADD COLUMN object_path TEXT;

CREATE INDEX idx_chunks_parent ON chunks(parent_id);
CREATE INDEX idx_chunks_object_path ON chunks(object_path);

CREATE TABLE chunk_identifiers (
  chunk_id       INTEGER NOT NULL,
  identifier     TEXT NOT NULL,
  normalized     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  PRIMARY KEY (chunk_id, normalized),
  FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id) ON DELETE CASCADE
);

CREATE INDEX idx_chunk_identifiers_normalized ON chunk_identifiers(normalized);
