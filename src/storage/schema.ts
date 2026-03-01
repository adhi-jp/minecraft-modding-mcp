export const SCHEMA_V1_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    coordinate TEXT,
    binary_jar_path TEXT,
    source_jar_path TEXT,
    repo_url TEXT,
    is_decompiled INTEGER NOT NULL CHECK (is_decompiled IN (0,1)),
    artifact_signature TEXT,
    version TEXT,
    requested_mapping TEXT,
    mapping_applied TEXT,
    provenance_json TEXT,
    quality_flags_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    artifact_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_bytes INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (artifact_id, file_path),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    artifact_id UNINDEXED,
    file_path,
    content,
    tokenize = 'unicode61 separators ''._$'''
  )`,
  `CREATE TABLE IF NOT EXISTS symbols (
    artifact_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    symbol_kind TEXT NOT NULL,
    symbol_name TEXT NOT NULL,
    qualified_name TEXT,
    line INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, file_path, symbol_kind, symbol_name, line),
    FOREIGN KEY (artifact_id, file_path) REFERENCES files(artifact_id, file_path) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS artifact_index_meta (
    artifact_id TEXT PRIMARY KEY,
    artifact_signature TEXT NOT NULL,
    index_schema_version INTEGER NOT NULL,
    files_count INTEGER NOT NULL,
    symbols_count INTEGER NOT NULL,
    fts_rows_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL,
    index_duration_ms INTEGER NOT NULL,
    last_error TEXT,
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS artifact_content_bytes (
    artifact_id TEXT PRIMARY KEY,
    total_content_bytes INTEGER NOT NULL CHECK (total_content_bytes >= 0),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_artifact ON files(artifact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_files_path ON files(artifact_id, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_lookup ON symbols(artifact_id, symbol_kind, symbol_name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_qname ON symbols(artifact_id, qualified_name)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_updated_at ON artifacts(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_index_meta_indexed_at ON artifact_index_meta(indexed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_name_lower ON symbols(artifact_id, lower(symbol_name))`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_file_line ON symbols(artifact_id, file_path, line)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_kind_file ON symbols(artifact_id, symbol_kind, file_path)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_content_bytes_total ON artifact_content_bytes(total_content_bytes)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_scoped_lookup
   ON symbols(artifact_id, symbol_kind, lower(symbol_name), file_path, line)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_scoped_lookup_no_kind
   ON symbols(artifact_id, lower(symbol_name), file_path, line)`,
  `INSERT INTO artifact_content_bytes (artifact_id, total_content_bytes)
   SELECT
     artifacts.artifact_id,
     COALESCE(
       SUM(
         CASE
           WHEN files.content_bytes > 0 THEN files.content_bytes
           ELSE 0
         END
       ),
       0
     ) AS total_content_bytes
   FROM artifacts
   LEFT JOIN files ON files.artifact_id = artifacts.artifact_id
   GROUP BY artifacts.artifact_id
   ON CONFLICT(artifact_id) DO UPDATE SET
     total_content_bytes = excluded.total_content_bytes`,
  `DELETE FROM artifact_content_bytes
   WHERE artifact_id NOT IN (SELECT artifact_id FROM artifacts)`,
  `CREATE TRIGGER IF NOT EXISTS trg_files_content_bytes_insert
   AFTER INSERT ON files
   BEGIN
     INSERT INTO artifact_content_bytes (artifact_id, total_content_bytes)
     VALUES (
       NEW.artifact_id,
       CASE
         WHEN NEW.content_bytes > 0 THEN NEW.content_bytes
         ELSE 0
       END
     )
     ON CONFLICT(artifact_id) DO UPDATE SET
       total_content_bytes = artifact_content_bytes.total_content_bytes + (
         CASE
           WHEN NEW.content_bytes > 0 THEN NEW.content_bytes
           ELSE 0
         END
       );
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_files_content_bytes_delete
   AFTER DELETE ON files
   BEGIN
     UPDATE artifact_content_bytes
     SET total_content_bytes = MAX(
       0,
       total_content_bytes - (
         CASE
           WHEN OLD.content_bytes > 0 THEN OLD.content_bytes
           ELSE 0
         END
       )
     )
     WHERE artifact_id = OLD.artifact_id;
   END`,
  `CREATE TRIGGER IF NOT EXISTS trg_files_content_bytes_update
   AFTER UPDATE OF artifact_id, content_bytes ON files
   BEGIN
     UPDATE artifact_content_bytes
     SET total_content_bytes = MAX(
       0,
       total_content_bytes - (
         CASE
           WHEN OLD.content_bytes > 0 THEN OLD.content_bytes
           ELSE 0
         END
       )
     )
     WHERE artifact_id = OLD.artifact_id;

     INSERT INTO artifact_content_bytes (artifact_id, total_content_bytes)
     VALUES (
       NEW.artifact_id,
       CASE
         WHEN NEW.content_bytes > 0 THEN NEW.content_bytes
         ELSE 0
       END
     )
     ON CONFLICT(artifact_id) DO UPDATE SET
       total_content_bytes = artifact_content_bytes.total_content_bytes + (
         CASE
           WHEN NEW.content_bytes > 0 THEN NEW.content_bytes
           ELSE 0
         END
       );
   END`
];
