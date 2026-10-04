import Database from "./sqlite.js";
import { createHash } from "node:crypto";
import type { FileRow, PagedResult } from "../types.js";
import { createError, ERROR_CODES } from "../errors.js";
import { log } from "../logger.js";

type SqliteDatabase = InstanceType<typeof Database>;

type CursorPayload = {
  sortKey: string;
};

type SearchCursorPayload = {
  score: number;
  filePath: string;
};

interface IndexedFile {
  filePath: string;
  content: string;
  contentBytes: number;
  contentHash: string;
}

interface ListFilesOptions {
  limit: number;
  cursor?: string;
  prefix?: string;
}

interface SearchFilesOptions {
  limit: number;
  query: string;
  match?: "exact" | "prefix" | "contains" | "regex";
  cursor?: string;
  mode?: "mixed" | "text" | "path";
  fetchLimitOverride?: number;
  /**
   * Literal file_path prefix (e.g. `net/minecraft/`) that narrows the candidate
   * queries through an escaped, ASCII case-insensitive `LIKE prefix%`. That match
   * set is a superset of a case-sensitive startsWith, so callers keep their own
   * exact scope check on the returned candidates.
   */
  pathPrefix?: string;
}

interface SearchFileCandidateResult {
  filePath: string;
  score: number;
  matchedIn: "path" | "content" | "both";
}

interface ListFileRowsOptions {
  limit: number;
  cursor?: string;
  prefix?: string;
}

function invalidCursorError() {
  return createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "Invalid pagination cursor.",
    details: {
      nextAction: "Omit the cursor parameter to start from the first page, or use a cursor value from a previous response."
    }
  });
}

/** Decode a base64 JSON cursor; anything undecodable or rejected by `guard` is an invalid cursor. */
function parseJsonCursor<T>(cursor: string | undefined, guard: (parsed: unknown) => parsed is T): T | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    if (guard(parsed)) {
      return parsed;
    }
  } catch {
    // Falls through to the invalid-cursor error below.
  }
  throw invalidCursorError();
}

function buildCursor(sortKey: string): string {
  return Buffer.from(JSON.stringify({ sortKey } as CursorPayload), "utf8").toString("base64");
}

function parseCursor(cursor: string | undefined): CursorPayload | undefined {
  return parseJsonCursor(cursor, (parsed): parsed is CursorPayload => typeof (parsed as CursorPayload).sortKey === "string");
}

function buildSearchCursor(score: number, filePath: string): string {
  return Buffer.from(JSON.stringify({ score, filePath } as SearchCursorPayload), "utf8").toString("base64");
}

function parseSearchCursor(cursor: string | undefined): SearchCursorPayload | undefined {
  return parseJsonCursor(
    cursor,
    (parsed): parsed is SearchCursorPayload =>
      typeof (parsed as SearchCursorPayload).score === "number" &&
      typeof (parsed as SearchCursorPayload).filePath === "string"
  );
}

function nextCursorFromRows(rows: { file_path: string }[], limit: number): string | undefined {
  if (rows.length === 0 || rows.length < limit) {
    return undefined;
  }

  const last = rows[rows.length - 1];
  return buildCursor(last.file_path);
}

function compareFilePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSearchOrdering(
  left: { score: number; filePath: string },
  right: { score: number; filePath: string }
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return compareFilePaths(left.filePath, right.filePath);
}

function isAfterSearchCursor(
  hit: { score: number; filePath: string },
  cursor: SearchCursorPayload
): boolean {
  if (hit.score < cursor.score) {
    return true;
  }
  if (hit.score > cursor.score) {
    return false;
  }
  return compareFilePaths(hit.filePath, cursor.filePath) > 0;
}

function tokenizeIndexedQuery(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Quote a token so FTS5 reads it as a string literal instead of grammar. Real
 * Minecraft identifiers tokenize into operator keywords (`BooleanOp.AND` ->
 * `BooleanOp AND`), which unquoted is either a syntax error or - mid-query, as
 * in `a NOT b` - a silent change of meaning.
 */
function quoteIndexedToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function buildIndexedMatchQuery(
  query: string,
  match: SearchFilesOptions["match"]
): string {
  const tokens = tokenizeIndexedQuery(query.trim());
  if (tokens.length === 0) {
    return query.trim();
  }

  // Separator-heavy queries become an order-agnostic FTS5 MATCH expression.
  // Whitespace is implicit AND, which keeps "dispatcher.register" on the indexed
  // path while SourceService re-checks hydrated path/content matches before
  // returning hits. Callers can still use literal mode for exact substring scans.
  return tokens.map((token, index) => {
    const quoted = quoteIndexedToken(token);
    if (match === "prefix" && index === tokens.length - 1) {
      return `${quoted}*`;
    }
    return quoted;
  }).join(" ");
}

/** Escape LIKE wildcards so the needle is matched literally under ESCAPE '\'. */
function escapeLikeNeedle(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class FilesRepo {
  private readonly deleteStmt;
  private readonly insertFilesStmt;
  private readonly getContentStmt;
  private readonly listStmt;
  private readonly listRowsStmt;
  private readonly searchPathStmt;
  private readonly searchContentLikePathsStmt;
  private readonly searchFtsStmt;
  private readonly getByPathsStmtCache = new Map<number, ReturnType<SqliteDatabase["prepare"]>>();
  private readonly classLookupStmtCache = new Map<number, ReturnType<SqliteDatabase["prepare"]>>();

  constructor(private readonly db: SqliteDatabase) {
    this.deleteStmt = this.db.prepare(`
      DELETE FROM files WHERE artifact_id = ?
    `);

    this.insertFilesStmt = this.db.prepare(`
      INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.getContentStmt = this.db.prepare(`
      SELECT artifact_id, file_path, content, content_bytes, content_hash
      FROM files
      WHERE artifact_id = ? AND file_path = ?
      LIMIT 1
    `);

    this.listStmt = this.db.prepare(`
      SELECT artifact_id, file_path
      FROM files
      WHERE artifact_id = ? AND file_path > ? AND (? IS NULL OR file_path LIKE ? ESCAPE '\\')
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.listRowsStmt = this.db.prepare(`
      SELECT artifact_id, file_path, content, content_bytes, content_hash
      FROM files
      WHERE artifact_id = ? AND file_path > ? AND (? IS NULL OR file_path LIKE ? ESCAPE '\\')
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.searchPathStmt = this.db.prepare(`
      SELECT file_path
      FROM files
      WHERE artifact_id = ? AND file_path LIKE ? ESCAPE '\\'
        AND (? IS NULL OR file_path LIKE ? ESCAPE '\\')
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.searchContentLikePathsStmt = this.db.prepare(`
      SELECT file_path
      FROM files
      WHERE artifact_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.searchFtsStmt = this.db.prepare(`
      SELECT file_path, rank
      FROM files_fts
      WHERE artifact_id = ? AND files_fts MATCH ?
        AND (? IS NULL OR file_path LIKE ? ESCAPE '\\')
      ORDER BY rank
      LIMIT ?
    `);
  }

  clearFilesForArtifact(artifactId: string): void {
    this.deleteStmt.run([artifactId]);
  }

  insertFilesForArtifact(artifactId: string, files: IndexedFile[]): void {
    for (const file of files) {
      const contentHash = file.contentHash || createHash("sha256").update(file.content).digest("hex");
      this.insertFilesStmt.run([
        artifactId,
        file.filePath,
        file.content,
        file.contentBytes,
        contentHash
      ]);
    }
  }

  replaceFilesForArtifact(artifactId: string, files: IndexedFile[]): void {
    const transaction = this.db.transaction(() => {
      this.clearFilesForArtifact(artifactId);
      this.insertFilesForArtifact(artifactId, files);
    });
    transaction();
  }

  getFileContent(artifactId: string, filePath: string): FileRow | undefined {
    const row = this.getContentStmt.get([artifactId, filePath]) as {
      artifact_id: string;
      file_path: string;
      content: string;
      content_bytes: number;
      content_hash: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      artifactId: row.artifact_id,
      filePath: row.file_path,
      content: row.content,
      contentBytes: row.content_bytes,
      contentHash: row.content_hash
    };
  }

  listFiles(artifactId: string, options: ListFilesOptions): PagedResult<string> {
    const cursor = parseCursor(options.cursor);
    const rows = this.listStmt.all(
      artifactId,
      cursor?.sortKey ?? "",
      options.prefix ?? null,
      options.prefix != null ? `${escapeLikeNeedle(options.prefix)}%` : "",
      Math.max(1, options.limit)
    ) as { file_path: string }[];

    return {
      items: rows.map((row) => row.file_path),
      nextCursor: nextCursorFromRows(rows, Math.max(1, options.limit))
    };
  }

  listFileRows(artifactId: string, options: ListFileRowsOptions): PagedResult<FileRow> {
    const cursor = parseCursor(options.cursor);
    const rows = this.listRowsStmt.all(
      artifactId,
      cursor?.sortKey ?? "",
      options.prefix ?? null,
      options.prefix != null ? `${escapeLikeNeedle(options.prefix)}%` : "",
      Math.max(1, options.limit)
    ) as {
      artifact_id: string;
      file_path: string;
      content: string;
      content_bytes: number;
      content_hash: string;
    }[];

    return {
      items: rows.map((row) => ({
        artifactId: row.artifact_id,
        filePath: row.file_path,
        content: row.content,
        contentBytes: row.content_bytes,
        contentHash: row.content_hash
      })),
      nextCursor: nextCursorFromRows(rows, Math.max(1, options.limit))
    };
  }

  /**
   * Narrow the literal/contains text-scan candidate set without hydrating content:
   * returns the file_paths whose content matches `content LIKE %needle%` (ASCII
   * case-insensitive). The result is a SUPERSET of the JS contains/exact match set
   * for an ASCII needle, so callers MUST still run the exact JS post-verify. Only
   * file_path is selected — content stays in the DB until getFileContentsByPaths.
   */
  searchContentLikeCandidatePaths(
    artifactId: string,
    needle: string,
    limit: number
  ): { filePaths: string[]; scannedRows: number } {
    const pattern = `%${escapeLikeNeedle(needle)}%`;
    const rows = this.searchContentLikePathsStmt.all(
      artifactId,
      pattern,
      Math.max(1, limit)
    ) as { file_path: string }[];
    return { filePaths: rows.map((row) => row.file_path), scannedRows: rows.length };
  }

  getFileContentsByPaths(artifactId: string, filePaths: string[]): FileRow[] {
    if (filePaths.length === 0) {
      return [];
    }
    const uniquePaths = [...new Set(filePaths)];
    const stmt = this.getFileContentsByPathsStmt(uniquePaths.length);
    const rows = stmt.all(artifactId, ...uniquePaths) as {
      artifact_id: string;
      file_path: string;
      content: string;
      content_bytes: number;
      content_hash: string;
    }[];

    const byPath = new Map(
      rows.map((row) => [
        row.file_path,
        {
          artifactId: row.artifact_id,
          filePath: row.file_path,
          content: row.content,
          contentBytes: row.content_bytes,
          contentHash: row.content_hash
        } as FileRow
      ])
    );

    return uniquePaths.map((path) => byPath.get(path)).filter((row): row is FileRow => row != null);
  }

  searchFileCandidates(
    artifactId: string,
    options: SearchFilesOptions
  ): PagedResult<SearchFileCandidateResult> & { scannedRows: number; dbRoundtrips: number } {
    const normalized = options.query.trim();
    if (!normalized) {
      return { items: [], nextCursor: undefined, scannedRows: 0, dbRoundtrips: 0 };
    }

    const cursor = parseSearchCursor(options.cursor);
    const likeQuery = `%${escapeLikeNeedle(normalized)}%`;
    const ftsQuery = buildIndexedMatchQuery(normalized, options.match);
    const scopePattern = options.pathPrefix ? `${escapeLikeNeedle(options.pathPrefix)}%` : null;
    const mode = options.mode ?? "mixed";

    // Cursor-adaptive fetch limit: when no cursor, use a generous limit;
    // with cursor + SQL pushdown, we need far fewer rows.
    const baseFetchLimit = options.fetchLimitOverride
      ?? (cursor ? Math.max(options.limit * 3, 50) : Math.max(options.limit * 5, 200));
    const fetchLimit = baseFetchLimit;

    // When cursor score is below all possible bands, skip both queries
    const cursorExhausted = cursor != null && cursor.score < 100;
    const includePath = mode !== "text" && !cursorExhausted;
    const includeContent = mode !== "path" && !cursorExhausted;

    const pathRows: { file_path: string }[] = includePath
      ? (this.searchPathStmt.all(artifactId, likeQuery, scopePattern, scopePattern, fetchLimit) as {
          file_path: string;
        }[])
      : [];

    const merged: SearchFileCandidateResult[] = pathRows.map((row) => ({
      filePath: row.file_path,
      score: 120,
      matchedIn: "path" as const
    }));
    const mergedByPath = new Map<string, SearchFileCandidateResult>(merged.map((hit) => [hit.filePath, hit]));

    let contentRows: { file_path: string; rank: number }[] = [];
    if (includeContent && ftsQuery) {
      try {
        contentRows = this.searchFtsStmt.all(artifactId, ftsQuery, scopePattern, scopePattern, fetchLimit) as {
          file_path: string;
          rank: number;
        }[];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/fts5:\s*syntax error/i.test(message)) {
          throw error;
        }
        log("warn", "storage.files.fts_syntax_error", {
          artifactId,
          query: ftsQuery,
          message
        });
      }
    }

    for (const row of contentRows) {
      // BM25 rank is negative (lower = better). Clamp -rank to [0, 19] for sub-tier scoring.
      const rankBonus = Math.min(19, Math.max(0, Math.round(-row.rank)));
      const existing = mergedByPath.get(row.file_path);
      if (existing) {
        existing.matchedIn = "both";
        existing.score = 140 + rankBonus;
        continue;
      }

      merged.push({
        filePath: row.file_path,
        score: 100 + rankBonus,
        matchedIn: "content"
      });
      mergedByPath.set(row.file_path, merged[merged.length - 1]);
    }

    const ordered = merged.sort(compareSearchOrdering);
    // Safety-net: still apply cursor filter for any rows that slipped through
    const filtered = cursor ? ordered.filter((hit) => isAfterSearchCursor(hit, cursor)) : ordered;
    const page = filtered.slice(0, options.limit);
    const hasMore = filtered.length > page.length;
    const nextCursor =
      hasMore && page.length > 0
        ? buildSearchCursor(page[page.length - 1].score, page[page.length - 1].filePath)
        : undefined;

    return {
      items: page,
      nextCursor,
      scannedRows: pathRows.length + contentRows.length,
      dbRoundtrips: (includePath ? 1 : 0) + (includeContent ? 1 : 0)
    };
  }

  private getClassLookupStmt(exactPathCount: number): ReturnType<SqliteDatabase["prepare"]> {
    const cached = this.classLookupStmtCache.get(exactPathCount);
    if (cached) {
      return cached;
    }

    const exactPlaceholders = Array.from({ length: exactPathCount }, () => "?").join(", ");
    const statement = this.db.prepare(`
      WITH ranked_candidates AS (
        SELECT file_path, 0 AS rank
        FROM files
        WHERE artifact_id = ?
          AND file_path IN (${exactPlaceholders})

        UNION ALL

        SELECT file_path,
          CASE
            WHEN qualified_name = ? THEN 1
            WHEN symbol_name = ? THEN 2
            ELSE 3
          END AS rank
        FROM symbols
        WHERE artifact_id = ?
          AND symbol_kind = 'class'
          AND (
            qualified_name = ?
            OR symbol_name = ?
            OR qualified_name LIKE ?
          )
          AND (? = '' OR instr(file_path, ?) = 1)

        UNION ALL

        SELECT file_path, 4 AS rank
        FROM files
        WHERE artifact_id = ?
          AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
          AND (? = '' OR instr(file_path, ?) = 1)
      )
      SELECT file_path
      FROM ranked_candidates
      ORDER BY rank ASC, file_path ASC
      LIMIT 1
    `);

    this.classLookupStmtCache.set(exactPathCount, statement);
    return statement;
  }

  findBestClassLookupPath(
    artifactId: string,
    exactFilePaths: string[],
    qualifiedClassName: string,
    simpleName: string,
    expectedPrefix: string
  ): string | undefined {
    const normalizedExactFilePaths = [...new Set(exactFilePaths.map((entry) => entry.trim()).filter(Boolean))];
    const normalizedClassName = qualifiedClassName.trim();
    const normalizedSimpleName = simpleName.trim();
    if (normalizedExactFilePaths.length === 0 || !normalizedClassName || !normalizedSimpleName) {
      return undefined;
    }

    const stmt = this.getClassLookupStmt(normalizedExactFilePaths.length);
    const fileName = `${normalizedSimpleName}.java`;
    const row = stmt.get(
      artifactId,
      ...normalizedExactFilePaths,
      normalizedClassName,
      normalizedSimpleName,
      artifactId,
      normalizedClassName,
      normalizedSimpleName,
      `%.${normalizedSimpleName}`,
      expectedPrefix,
      expectedPrefix,
      artifactId,
      fileName,
      `%/${fileName}`,
      expectedPrefix,
      expectedPrefix
    ) as { file_path?: string } | undefined;

    return row?.file_path;
  }

  private getFileContentsByPathsStmt(pathCount: number) {
    const normalizedCount = Math.max(1, Math.trunc(pathCount));
    const cached = this.getByPathsStmtCache.get(normalizedCount);
    if (cached) {
      this.getByPathsStmtCache.delete(normalizedCount);
      this.getByPathsStmtCache.set(normalizedCount, cached);
      return cached;
    }

    if (this.getByPathsStmtCache.size >= 64) {
      const oldestKey = this.getByPathsStmtCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.getByPathsStmtCache.delete(oldestKey);
      }
    }

    const placeholders = Array.from({ length: normalizedCount }, () => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT artifact_id, file_path, content, content_bytes, content_hash
      FROM files
      WHERE artifact_id = ? AND file_path IN (${placeholders})
    `);
    this.getByPathsStmtCache.set(normalizedCount, stmt);
    return stmt;
  }
}
