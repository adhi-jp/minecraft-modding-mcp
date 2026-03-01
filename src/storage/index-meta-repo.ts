import Database from "./sqlite.js";

type SqliteDatabase = InstanceType<typeof Database>;

interface IndexMetaRecord {
  artifact_id: string;
  artifact_signature: string;
  index_schema_version: number;
  files_count: number;
  symbols_count: number;
  fts_rows_count: number;
  indexed_at: string;
  index_duration_ms: number;
  last_error: string | null;
}

export interface ArtifactIndexMetaRow {
  artifactId: string;
  artifactSignature: string;
  indexSchemaVersion: number;
  filesCount: number;
  symbolsCount: number;
  ftsRowsCount: number;
  indexedAt: string;
  indexDurationMs: number;
  lastError?: string;
}

export interface UpsertArtifactIndexMetaInput {
  artifactId: string;
  artifactSignature: string;
  indexSchemaVersion: number;
  filesCount: number;
  symbolsCount: number;
  ftsRowsCount: number;
  indexedAt: string;
  indexDurationMs: number;
  lastError?: string;
}

function toRow(record: IndexMetaRecord): ArtifactIndexMetaRow {
  return {
    artifactId: record.artifact_id,
    artifactSignature: record.artifact_signature,
    indexSchemaVersion: record.index_schema_version,
    filesCount: record.files_count,
    symbolsCount: record.symbols_count,
    ftsRowsCount: record.fts_rows_count,
    indexedAt: record.indexed_at,
    indexDurationMs: record.index_duration_ms,
    lastError: record.last_error ?? undefined
  };
}

export class IndexMetaRepo {
  private readonly getStmt;
  private readonly upsertStmt;
  private readonly deleteStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.getStmt = this.db.prepare<IndexMetaRecord>(`
      SELECT
        artifact_id,
        artifact_signature,
        index_schema_version,
        files_count,
        symbols_count,
        fts_rows_count,
        indexed_at,
        index_duration_ms,
        last_error
      FROM artifact_index_meta
      WHERE artifact_id = ?
      LIMIT 1
    `);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO artifact_index_meta (
        artifact_id,
        artifact_signature,
        index_schema_version,
        files_count,
        symbols_count,
        fts_rows_count,
        indexed_at,
        index_duration_ms,
        last_error
      ) VALUES (
        @artifact_id,
        @artifact_signature,
        @index_schema_version,
        @files_count,
        @symbols_count,
        @fts_rows_count,
        @indexed_at,
        @index_duration_ms,
        @last_error
      )
      ON CONFLICT(artifact_id) DO UPDATE SET
        artifact_signature = excluded.artifact_signature,
        index_schema_version = excluded.index_schema_version,
        files_count = excluded.files_count,
        symbols_count = excluded.symbols_count,
        fts_rows_count = excluded.fts_rows_count,
        indexed_at = excluded.indexed_at,
        index_duration_ms = excluded.index_duration_ms,
        last_error = excluded.last_error
    `);

    this.deleteStmt = this.db.prepare(`
      DELETE FROM artifact_index_meta
      WHERE artifact_id = ?
    `);
  }

  get(artifactId: string): ArtifactIndexMetaRow | undefined {
    const row = this.getStmt.get([artifactId]);
    if (!row) {
      return undefined;
    }
    return toRow(row);
  }

  upsert(input: UpsertArtifactIndexMetaInput): void {
    this.upsertStmt.run({
      artifact_id: input.artifactId,
      artifact_signature: input.artifactSignature,
      index_schema_version: input.indexSchemaVersion,
      files_count: input.filesCount,
      symbols_count: input.symbolsCount,
      fts_rows_count: input.ftsRowsCount,
      indexed_at: input.indexedAt,
      index_duration_ms: Math.max(0, Math.trunc(input.indexDurationMs)),
      last_error: input.lastError ?? null
    });
  }

  delete(artifactId: string): void {
    this.deleteStmt.run([artifactId]);
  }
}
