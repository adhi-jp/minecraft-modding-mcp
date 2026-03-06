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

export interface IndexedFile {
  filePath: string;
  content: string;
  contentBytes: number;
  contentHash: string;
}

export interface ListFilesOptions {
  limit: number;
  cursor?: string;
  prefix?: string;
}

export interface SearchFilesOptions {
  limit: number;
  query: string;
  cursor?: string;
  mode?: "mixed" | "text" | "path";
  fetchLimitOverride?: number;
}

export interface SearchFilesResult {
  filePath: string;
  score: number;
  matchedIn: "path" | "content" | "both";
  preview: string;
}

export interface SearchFileCandidateResult {
  filePath: string;
  score: number;
  matchedIn: "path" | "content" | "both";
}

export interface SearchFilesWithContentResult extends SearchFilesResult {
  content: string;
}

export interface FileContentPrefixRow {
  artifactId: string;
  filePath: string;
  contentPrefix: string;
  truncated: boolean;
}

export interface ListFileRowsOptions {
  limit: number;
  cursor?: string;
  prefix?: string;
}

function buildCursor(sortKey: string): string {
  return Buffer.from(JSON.stringify({ sortKey } as CursorPayload), "utf8").toString("base64");
}

function parseCursor(cursor: string | undefined): CursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorPayload;
    if (typeof parsed.sortKey !== "string") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Invalid pagination cursor.",
        details: {
          nextAction: "Omit the cursor parameter to start from the first page, or use a cursor value from a previous response."
        }
      });
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && "code" in err) throw err;
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Invalid pagination cursor.",
      details: {
        nextAction: "Omit the cursor parameter to start from the first page, or use a cursor value from a previous response."
      }
    });
  }
}

function buildSearchCursor(score: number, filePath: string): string {
  return Buffer.from(JSON.stringify({ score, filePath } as SearchCursorPayload), "utf8").toString("base64");
}

function parseSearchCursor(cursor: string | undefined): SearchCursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as SearchCursorPayload;
    if (typeof parsed.score !== "number" || typeof parsed.filePath !== "string") {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Invalid pagination cursor.",
        details: {
          nextAction: "Omit the cursor parameter to start from the first page, or use a cursor value from a previous response."
        }
      });
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && "code" in err) throw err;
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Invalid pagination cursor.",
      details: {
        nextAction: "Omit the cursor parameter to start from the first page, or use a cursor value from a previous response."
      }
    });
  }
}

function nextCursorFromRows(rows: { file_path: string }[]): string | undefined {
  if (rows.length === 0) {
    return undefined;
  }

  const last = rows[rows.length - 1];
  return buildCursor(last.file_path);
}

function compareSearchOrdering(
  left: { score: number; filePath: string },
  right: { score: number; filePath: string }
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return left.filePath.localeCompare(right.filePath);
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
  return hit.filePath.localeCompare(cursor.filePath) > 0;
}

function buildPreview(content: string, query: string): string {
  const normalizedQuery = query.toLowerCase();
  const normalizedContent = content.toLowerCase();
  const index = normalizedContent.indexOf(normalizedQuery);
  if (index < 0) {
    return content.slice(0, 120);
  }
  const start = Math.max(0, index - 24);
  const end = Math.min(content.length, index + normalizedQuery.length + 24);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end)}${suffix}`.replace(/\s+/g, " ").trim();
}

export class FilesRepo {
  private readonly deleteStmt;
  private readonly insertFilesStmt;
  private readonly insertFtsStmt;
  private readonly deleteFtsStmt;
  private readonly getContentStmt;
  private readonly listStmt;
  private readonly listRowsStmt;
  private readonly searchPathStmt;
  private readonly searchFtsStmt;
  private readonly getByPathsStmtCache = new Map<number, ReturnType<SqliteDatabase["prepare"]>>();
  private readonly getPrefixByPathsStmtCache = new Map<string, ReturnType<SqliteDatabase["prepare"]>>();

  constructor(private readonly db: SqliteDatabase) {
    this.deleteStmt = this.db.prepare(`
      DELETE FROM files WHERE artifact_id = ?
    `);

    this.deleteFtsStmt = this.db.prepare(`
      DELETE FROM files_fts WHERE artifact_id = ?
    `);

    this.insertFilesStmt = this.db.prepare(`
      INSERT INTO files (artifact_id, file_path, content, content_bytes, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.insertFtsStmt = this.db.prepare(`
      INSERT INTO files_fts (artifact_id, file_path, content)
      VALUES (?, ?, ?)
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
      WHERE artifact_id = ? AND file_path > ? AND (? IS NULL OR file_path LIKE ? || '%')
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.listRowsStmt = this.db.prepare(`
      SELECT artifact_id, file_path, content, content_bytes, content_hash
      FROM files
      WHERE artifact_id = ? AND file_path > ? AND (? IS NULL OR file_path LIKE ? || '%')
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.searchPathStmt = this.db.prepare(`
      SELECT file_path
      FROM files
      WHERE artifact_id = ? AND file_path LIKE ? ESCAPE '\\'
      ORDER BY file_path ASC
      LIMIT ?
    `);

    this.searchFtsStmt = this.db.prepare(`
      SELECT file_path, rank
      FROM files_fts
      WHERE artifact_id = ? AND files_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
  }

  clearFilesForArtifact(artifactId: string): void {
    this.deleteStmt.run([artifactId]);
    this.deleteFtsStmt.run([artifactId]);
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
      this.insertFtsStmt.run([artifactId, file.filePath, file.content]);
    }
  }

  replaceFilesForArtifact(artifactId: string, files: IndexedFile[]): void {
    const transaction = this.db.transaction(() => {
      this.clearFilesForArtifact(artifactId);
      this.insertFilesForArtifact(artifactId, files);
    });
    transaction();
  }

  deleteFilesForArtifact(artifactId: string): void {
    const transaction = this.db.transaction(() => {
      this.clearFilesForArtifact(artifactId);
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
      options.prefix ?? "",
      Math.max(1, options.limit)
    ) as { file_path: string }[];

    return {
      items: rows.map((row) => row.file_path),
      nextCursor: nextCursorFromRows(rows)
    };
  }

  listFileRows(artifactId: string, options: ListFileRowsOptions): PagedResult<FileRow> {
    const cursor = parseCursor(options.cursor);
    const rows = this.listRowsStmt.all(
      artifactId,
      cursor?.sortKey ?? "",
      options.prefix ?? null,
      options.prefix ?? "",
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
      nextCursor: nextCursorFromRows(rows)
    };
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

  getFileContentPrefixesByPaths(
    artifactId: string,
    filePaths: string[],
    maxChars: number
  ): FileContentPrefixRow[] {
    if (filePaths.length === 0) {
      return [];
    }

    const normalizedMaxChars = Math.max(1, Math.trunc(maxChars));
    const uniquePaths = [...new Set(filePaths)];
    const stmt = this.getFileContentPrefixesByPathsStmt(uniquePaths.length, normalizedMaxChars);
    const rows = stmt.all(normalizedMaxChars, artifactId, ...uniquePaths) as {
      artifact_id: string;
      file_path: string;
      content_prefix: string;
      content_length: number;
    }[];

    const byPath = new Map(
      rows.map((row) => [
        row.file_path,
        {
          artifactId: row.artifact_id,
          filePath: row.file_path,
          contentPrefix: row.content_prefix,
          truncated: row.content_length > row.content_prefix.length
        } as FileContentPrefixRow
      ])
    );

    return uniquePaths
      .map((path) => byPath.get(path))
      .filter((row): row is FileContentPrefixRow => row != null);
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
    const likeQuery = `%${normalized}%`;
    const mode = options.mode ?? "mixed";

    // Cursor-adaptive fetch limit: when no cursor, use a generous limit;
    // with cursor + SQL pushdown, we need far fewer rows.
    const baseFetchLimit = options.fetchLimitOverride
      ?? (cursor ? Math.max(options.limit * 3, 50) : Math.max(options.limit * 5, 200));
    const fetchLimit = baseFetchLimit;

    // When cursor score is below all possible bands, skip both queries
    const cursorExhausted = cursor != null && cursor.score < 100;
    // Skip path query entirely when cursor is within the content-only tier
    const cursorPastPath = cursor != null && cursor.score < 120;
    const includePath = mode !== "text" && !cursorExhausted && !cursorPastPath;
    const includeContent = mode !== "path" && !cursorExhausted;

    // Path query: push cursor into SQL when cursor.score == 120 (within path tier)
    let pathRows: { file_path: string }[];
    if (includePath && cursor && cursor.score === 120) {
      // Cursor is within the path tier — only fetch paths after cursor.filePath
      pathRows = this.db.prepare(`
        SELECT file_path
        FROM files
        WHERE artifact_id = ? AND file_path LIKE ? ESCAPE '\\' AND file_path > ?
        ORDER BY file_path ASC
        LIMIT ?
      `).all(artifactId, likeQuery, cursor.filePath, fetchLimit) as { file_path: string }[];
    } else if (includePath) {
      pathRows = this.searchPathStmt.all(artifactId, likeQuery, fetchLimit) as {
        file_path: string;
      }[];
    } else {
      pathRows = [];
    }

    const merged: SearchFileCandidateResult[] = pathRows.map((row) => ({
      filePath: row.file_path,
      score: 120,
      matchedIn: "path" as const
    }));
    const mergedByPath = new Map<string, SearchFileCandidateResult>(merged.map((hit) => [hit.filePath, hit]));

    let contentRows: { file_path: string; rank: number }[] = [];
    if (includeContent) {
      try {
        contentRows = this.searchFtsStmt.all(artifactId, normalized, fetchLimit) as {
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
          query: normalized,
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

  searchFilesWithContent(
    artifactId: string,
    options: SearchFilesOptions
  ): PagedResult<SearchFilesWithContentResult> & { scannedRows: number; dbRoundtrips: number } {
    const page = this.searchFileCandidates(artifactId, options);
    if (page.items.length === 0) {
      return {
        items: [],
        nextCursor: page.nextCursor,
        scannedRows: page.scannedRows,
        dbRoundtrips: page.dbRoundtrips
      };
    }

    const rows = this.getFileContentsByPaths(
      artifactId,
      page.items.map((item) => item.filePath)
    );
    const byPath = new Map(rows.map((row) => [row.filePath, row]));

    return {
      items: page.items
        .map((item) => {
          const contentRow = byPath.get(item.filePath);
          if (!contentRow) {
            return undefined;
          }
          return {
            filePath: item.filePath,
            score: item.score,
            matchedIn: item.matchedIn,
            preview: buildPreview(contentRow.content, options.query),
            content: contentRow.content
          } as SearchFilesWithContentResult;
        })
        .filter((row): row is SearchFilesWithContentResult => row != null),
      nextCursor: page.nextCursor,
      scannedRows: page.scannedRows + rows.length,
      dbRoundtrips: page.dbRoundtrips + 1
    };
  }

  countTextCandidates(artifactId: string, query: string): number {
    const normalized = query.trim();
    if (!normalized) {
      return 0;
    }
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS cnt FROM files_fts WHERE artifact_id = ? AND files_fts MATCH ?`
      ).get(artifactId, normalized) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      log("warn", "storage.files.count_text_candidates_failed", {
        artifactId,
        query: normalized
      });
      return 0;
    }
  }

  countPathCandidates(artifactId: string, query: string): number {
    const normalized = query.trim();
    if (!normalized) {
      return 0;
    }
    const likeQuery = `%${normalized}%`;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM files WHERE artifact_id = ? AND file_path LIKE ? ESCAPE '\\'`
    ).get(artifactId, likeQuery) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  findFirstFilePathByName(artifactId: string, fileName: string): string | undefined {
    const normalized = fileName.trim();
    if (!normalized) {
      return undefined;
    }

    const row = this.db
      .prepare(`
        SELECT file_path
        FROM files
        WHERE artifact_id = ?
          AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
        ORDER BY file_path ASC
        LIMIT 1
      `)
      .get(artifactId, normalized, `%/${normalized}`) as { file_path?: string } | undefined;

    return row?.file_path;
  }

  searchFiles(artifactId: string, options: SearchFilesOptions): PagedResult<SearchFilesResult> {
    const page = this.searchFilesWithContent(artifactId, options);
    return {
      items: page.items.map(({ content: _content, ...rest }) => rest),
      nextCursor: page.nextCursor
    };
  }

  totalContentBytes(): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(content_bytes), 0) AS total
        FROM files
      `)
      .get() as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  contentBytesForArtifact(artifactId: string): number {
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(content_bytes), 0) AS total
        FROM files
        WHERE artifact_id = ?
      `)
      .get([artifactId]) as { total?: number } | undefined;
    return row?.total ?? 0;
  }

  private getFileContentsByPathsStmt(pathCount: number) {
    const normalizedCount = Math.max(1, Math.trunc(pathCount));
    const cached = this.getByPathsStmtCache.get(normalizedCount);
    if (cached) {
      return cached;
    }

    if (this.getByPathsStmtCache.size >= 64) {
      this.getByPathsStmtCache.clear();
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

  private getFileContentPrefixesByPathsStmt(pathCount: number, maxChars: number) {
    const normalizedCount = Math.max(1, Math.trunc(pathCount));
    const normalizedMaxChars = Math.max(1, Math.trunc(maxChars));
    const cacheKey = `${normalizedCount}:${normalizedMaxChars}`;
    const cached = this.getPrefixByPathsStmtCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (this.getPrefixByPathsStmtCache.size >= 128) {
      this.getPrefixByPathsStmtCache.clear();
    }

    const placeholders = Array.from({ length: normalizedCount }, () => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT artifact_id, file_path, substr(content, 1, ?) AS content_prefix, length(content) AS content_length
      FROM files
      WHERE artifact_id = ? AND file_path IN (${placeholders})
    `);
    this.getPrefixByPathsStmtCache.set(cacheKey, stmt);
    return stmt;
  }
}
