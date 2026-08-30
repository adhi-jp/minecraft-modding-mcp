import Database from "./sqlite.js";
import type { ArtifactProvenance, ArtifactRow, SourceMapping, SourceOrigin } from "../types.js";
import { log } from "../logger.js";

type SqliteDatabase = InstanceType<typeof Database>;

interface ArtifactRepoRecord {
  artifact_id: string;
  alias: string | null;
  origin: SourceOrigin;
  coordinate: string | null;
  version: string | null;
  binary_jar_path: string | null;
  source_jar_path: string | null;
  repo_url: string | null;
  requested_mapping: SourceMapping | null;
  mapping_applied: SourceMapping | null;
  provenance_json: string | null;
  quality_flags_json: string | null;
  artifact_signature: string | null;
  is_decompiled: number;
  created_at: string;
  updated_at: string;
}

interface UpsertArtifactInput {
  artifactId: string;
  alias?: string;
  origin: SourceOrigin;
  coordinate?: string;
  version?: string;
  binaryJarPath?: string;
  sourceJarPath?: string;
  repoUrl?: string;
  requestedMapping?: SourceMapping;
  mappingApplied?: SourceMapping;
  provenance?: ArtifactProvenance;
  qualityFlags?: string[];
  artifactSignature?: string;
  isDecompiled: boolean;
  timestamp: string;
}

export interface ArtifactContentBytesRow {
  artifactId: string;
  totalContentBytes: number;
  updatedAt: string;
}

function parseProvenance(value: string | null): ArtifactProvenance | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as ArtifactProvenance;
    return parsed;
  } catch {
    log("warn", "storage.artifacts.invalid_provenance_json", {
      value: value.slice(0, 200)
    });
    return undefined;
  }
}

function parseQualityFlags(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    log("warn", "storage.artifacts.invalid_quality_flags_json", {
      value: value.slice(0, 200)
    });
    return [];
  }
}

function toArtifactRow(record: ArtifactRepoRecord): ArtifactRow {
  return {
    artifactId: record.artifact_id,
    alias: record.alias ?? undefined,
    origin: record.origin,
    coordinate: record.coordinate ?? undefined,
    version: record.version ?? undefined,
    binaryJarPath: record.binary_jar_path ?? undefined,
    sourceJarPath: record.source_jar_path ?? undefined,
    repoUrl: record.repo_url ?? undefined,
    requestedMapping: record.requested_mapping ?? undefined,
    mappingApplied: record.mapping_applied ?? undefined,
    provenance: parseProvenance(record.provenance_json),
    qualityFlags: parseQualityFlags(record.quality_flags_json),
    artifactSignature: record.artifact_signature ?? undefined,
    isDecompiled: record.is_decompiled === 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

function toBooleanValue(isDecompiled: boolean): number {
  return isDecompiled ? 1 : 0;
}

export class ArtifactsRepo {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly touchStmt;
  private readonly setAliasStmt;
  private readonly updateBinaryJarPathStmt;
  private readonly deleteStmt;
  private readonly listStmt;
  private readonly countStmt;
  private readonly totalContentBytesStmt;
  private readonly listLruWithContentBytesStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.upsertStmt = this.db.prepare(`
      INSERT INTO artifacts (
        artifact_id, alias, origin, coordinate, version, binary_jar_path, source_jar_path, repo_url, requested_mapping, mapping_applied, provenance_json, quality_flags_json, artifact_signature, is_decompiled, created_at, updated_at
      ) VALUES (
        @artifact_id, @alias, @origin, @coordinate, @version, @binary_jar_path, @source_jar_path, @repo_url, @requested_mapping, @mapping_applied, @provenance_json, @quality_flags_json, @artifact_signature, @is_decompiled, @created_at, @updated_at
      )
      ON CONFLICT(artifact_id) DO UPDATE SET
        alias = excluded.alias,
        origin = excluded.origin,
        coordinate = excluded.coordinate,
        version = excluded.version,
        binary_jar_path = excluded.binary_jar_path,
        source_jar_path = excluded.source_jar_path,
        repo_url = excluded.repo_url,
        requested_mapping = excluded.requested_mapping,
        mapping_applied = excluded.mapping_applied,
        provenance_json = excluded.provenance_json,
        quality_flags_json = excluded.quality_flags_json,
        artifact_signature = excluded.artifact_signature,
        is_decompiled = excluded.is_decompiled,
        updated_at = excluded.updated_at
    `);

    // artifact_id is a 64-char SHA hex; alias is `<type>-<...>-<6charhex>` containing
    // dashes/letters. The two namespaces cannot collide, so OR-matching is unambiguous.
    this.getStmt = this.db.prepare<ArtifactRepoRecord>(`
      SELECT
        artifact_id,
        alias,
        origin,
        coordinate,
        version,
        binary_jar_path,
        source_jar_path,
        repo_url,
        requested_mapping,
        mapping_applied,
        provenance_json,
        quality_flags_json,
        artifact_signature,
        is_decompiled,
        created_at,
        updated_at
      FROM artifacts
      WHERE artifact_id = ? OR alias = ?
      LIMIT 1
    `);

    this.touchStmt = this.db.prepare(`
      UPDATE artifacts
      SET updated_at = ?
      WHERE artifact_id = ?
    `);

    // Persists alias on cache-hit / migrated-row paths where upsertArtifact would
    // otherwise be skipped. Conditional WHERE keeps it idempotent and avoids a
    // pointless write when alias is already correct.
    this.setAliasStmt = this.db.prepare(`
      UPDATE artifacts
      SET alias = ?
      WHERE artifact_id = ?
        AND (alias IS NULL OR alias <> ?)
    `);

    // Persists binary_jar_path on cache-hit paths where upsertArtifact would
    // otherwise be skipped. Conditional WHERE keeps it idempotent and avoids a
    // pointless write when the column already names the same jar. Never writes
    // NULL: the setter only runs with a jar the resolver just proved usable.
    this.updateBinaryJarPathStmt = this.db.prepare(`
      UPDATE artifacts
      SET binary_jar_path = ?
      WHERE artifact_id = ?
        AND (binary_jar_path IS NULL OR binary_jar_path <> ?)
    `);

    this.deleteStmt = this.db.prepare(`DELETE FROM artifacts WHERE artifact_id = ?`);

    this.listStmt = this.db.prepare<ArtifactRepoRecord>(`
      SELECT
        artifact_id,
        alias,
        origin,
        coordinate,
        version,
        binary_jar_path,
        source_jar_path,
        repo_url,
        requested_mapping,
        mapping_applied,
        provenance_json,
        quality_flags_json,
        artifact_signature,
        is_decompiled,
        created_at,
        updated_at
      FROM artifacts
      ORDER BY updated_at ASC
      LIMIT ?
    `);

    this.countStmt = this.db.prepare<{ total: number }>(`
      SELECT COUNT(*) AS total
      FROM artifacts
    `);

    this.totalContentBytesStmt = this.db.prepare<{ total: number }>(`
      SELECT COALESCE(SUM(total_content_bytes), 0) AS total
      FROM artifact_content_bytes
    `);

    this.listLruWithContentBytesStmt = this.db.prepare<{
      artifact_id: string;
      total_content_bytes: number;
      updated_at: string;
    }>(`
      SELECT
        artifacts.artifact_id,
        COALESCE(artifact_content_bytes.total_content_bytes, 0) AS total_content_bytes,
        artifacts.updated_at
      FROM artifacts
      LEFT JOIN artifact_content_bytes
        ON artifact_content_bytes.artifact_id = artifacts.artifact_id
      ORDER BY artifacts.updated_at ASC
      LIMIT ?
    `);
  }

  upsertArtifact(input: UpsertArtifactInput): void {
    this.upsertStmt.run({
      artifact_id: input.artifactId,
      alias: input.alias ?? null,
      origin: input.origin,
      coordinate: input.coordinate ?? null,
      version: input.version ?? null,
      binary_jar_path: input.binaryJarPath ?? null,
      source_jar_path: input.sourceJarPath ?? null,
      repo_url: input.repoUrl ?? null,
      requested_mapping: input.requestedMapping ?? null,
      mapping_applied: input.mappingApplied ?? null,
      provenance_json: input.provenance ? JSON.stringify(input.provenance) : null,
      quality_flags_json: input.qualityFlags ? JSON.stringify(input.qualityFlags) : null,
      artifact_signature: input.artifactSignature ?? null,
      is_decompiled: toBooleanValue(input.isDecompiled),
      created_at: input.timestamp,
      updated_at: input.timestamp
    });
  }

  // Accepts either an artifact_id (64-char SHA hex) or a human-readable alias
  // (e.g. `mc-1.21.10-mojang-merged-5ad2e7`). The two key namespaces cannot
  // collide because aliases always contain `-` and a non-hex prefix.
  getArtifact(artifactIdOrAlias: string): ArtifactRow | undefined {
    const row = this.getStmt.get([artifactIdOrAlias, artifactIdOrAlias]);
    if (!row) {
      return undefined;
    }

    return toArtifactRow(row);
  }

  touchArtifact(artifactId: string, timestamp: string): void {
    this.touchStmt.run([timestamp, artifactId]);
  }

  // Backfills or rotates the alias for an existing row. Used by warm-cache
  // resolveArtifact paths where upsertArtifact is skipped, so a freshly
  // computed alias still reaches the DB and stays in sync with the value the
  // caller just received in the response.
  setAlias(artifactId: string, alias: string): void {
    this.setAliasStmt.run([alias, artifactId, alias]);
  }

  // Backfills or repoints the binary jar for an existing row. Used by warm-cache
  // resolveArtifact paths where upsertArtifact is skipped, so a binary companion
  // that only appeared after the row was written - or a remap output reconciled
  // on the cache-hit path - still reaches the DB and stays in sync with the
  // binaryJarPath the caller just received in the response. Callers pass the jar
  // a binary consumer should open right now, matching what upsertArtifact stores
  // on the cold path. `updated_at` is deliberately left alone: the one warm path
  // that calls this already runs touchArtifact with its own LRU timestamp.
  updateBinaryJarPath(artifactId: string, binaryJarPath: string): void {
    this.updateBinaryJarPathStmt.run([binaryJarPath, artifactId, binaryJarPath]);
  }

  deleteArtifact(artifactId: string): void {
    this.deleteStmt.run([artifactId]);
  }

  listArtifactsByLru(limit: number): ArtifactRow[] {
    return this.listStmt.all([limit]).map(toArtifactRow);
  }

  countArtifacts(): number {
    const row = this.countStmt.get() as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  totalContentBytes(): number {
    const row = this.totalContentBytesStmt.get() as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  listArtifactsByLruWithContentBytes(limit: number): ArtifactContentBytesRow[] {
    const rows = this.listLruWithContentBytesStmt.all([Math.max(1, Math.trunc(limit))]) as {
      artifact_id: string;
      total_content_bytes: number;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      artifactId: row.artifact_id,
      totalContentBytes: row.total_content_bytes,
      updatedAt: row.updated_at
    }));
  }
}
