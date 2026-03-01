import Database from "./sqlite.js";
import type { PagedResult, SymbolRow } from "../types.js";
import { log } from "../logger.js";

type SqliteDatabase = InstanceType<typeof Database>;

export interface IndexedSymbol {
  filePath: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

export interface FindSymbolsOptions {
  artifactId: string;
  symbolKind?: string;
  symbolNamePrefix?: string;
  exact?: boolean;
  limit: number;
  cursor?: string;
}

type ScopedSymbolMatch = "exact" | "prefix" | "contains";

export interface FindScopedSymbolsOptions {
  artifactId: string;
  query: string;
  match: ScopedSymbolMatch;
  symbolKind?: string;
  packagePrefix?: string;
  filePathLike?: string;
  limit?: number;
  cursor?: { symbolName: string; filePath: string; line: number };
}

function toSymbolRow(artifactId: string, item: IndexedSymbol): SymbolRow {
  return {
    artifactId,
    filePath: item.filePath,
    symbolKind: item.symbolKind,
    symbolName: item.symbolName,
    qualifiedName: item.qualifiedName,
    line: item.line
  };
}

type SymbolCursorPayload = {
  symbolName: string;
  filePath: string;
  line: number;
};

function encodeCursor(symbolName: string, filePath: string, line: number): string {
  return Buffer.from(JSON.stringify({ symbolName, filePath, line } as SymbolCursorPayload), "utf8").toString("base64");
}

function decodeCursor(cursor: string | undefined): SymbolCursorPayload | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as SymbolCursorPayload;
    if (
      typeof parsed.symbolName !== "string" ||
      typeof parsed.filePath !== "string" ||
      typeof parsed.line !== "number"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    log("warn", "storage.symbols.invalid_cursor", { cursor });
    return undefined;
  }
}

function isAfterCursor(
  row: { symbol_name: string; file_path: string; line: number },
  cursor: SymbolCursorPayload
): boolean {
  const symbolCompare = row.symbol_name.localeCompare(cursor.symbolName);
  if (symbolCompare > 0) {
    return true;
  }
  if (symbolCompare < 0) {
    return false;
  }

  const fileCompare = row.file_path.localeCompare(cursor.filePath);
  if (fileCompare > 0) {
    return true;
  }
  if (fileCompare < 0) {
    return false;
  }

  return row.line > cursor.line;
}

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class SymbolsRepo {
  private readonly deleteStmt;
  private readonly insertStmt;
  private readonly searchStmt;
  private readonly searchExactStmt;
  private readonly listByArtifactStmt;
  private readonly listByArtifactKindStmt;
  private readonly listByFileStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.deleteStmt = this.db.prepare(`
      DELETE FROM symbols WHERE artifact_id = ?
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO symbols (artifact_id, file_path, symbol_kind, symbol_name, qualified_name, line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.searchStmt = this.db.prepare(`
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
        AND (symbol_kind = ? OR ? = '')
        AND (symbol_name LIKE ? ESCAPE '\\')
      ORDER BY symbol_name ASC, file_path ASC, line ASC
      LIMIT ?
    `);

    this.searchExactStmt = this.db.prepare(`
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
        AND (symbol_kind = ? OR ? = '')
        AND symbol_name = ?
      ORDER BY symbol_name ASC, file_path ASC, line ASC
      LIMIT ?
    `);

    this.listByArtifactStmt = this.db.prepare(`
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
      ORDER BY symbol_name ASC, file_path ASC, line ASC
    `);

    this.listByArtifactKindStmt = this.db.prepare(`
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ? AND symbol_kind = ?
      ORDER BY symbol_name ASC, file_path ASC, line ASC
    `);

    this.listByFileStmt = this.db.prepare(`
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ? AND file_path = ?
      ORDER BY line ASC, symbol_name ASC
    `);
  }

  clearSymbolsForArtifact(artifactId: string): void {
    this.deleteStmt.run([artifactId]);
  }

  insertSymbolsForArtifact(artifactId: string, symbols: IndexedSymbol[]): void {
    for (const item of symbols) {
      this.insertStmt.run([
        artifactId,
        item.filePath,
        item.symbolKind,
        item.symbolName,
        item.qualifiedName ?? null,
        item.line
      ]);
    }
  }

  replaceSymbolsForArtifact(artifactId: string, symbols: IndexedSymbol[]): void {
    const transaction = this.db.transaction(() => {
      this.clearSymbolsForArtifact(artifactId);
      this.insertSymbolsForArtifact(artifactId, symbols);
    });

    transaction();
  }

  findSymbols(options: FindSymbolsOptions): PagedResult<SymbolRow> {
    const cursor = decodeCursor(options.cursor);
    const symbolName = options.symbolNamePrefix ?? "";
    const fetchLimit = options.limit + 1;

    type SymbolQueryRow = {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    };

    let rows: SymbolQueryRow[];

    if (cursor) {
      const nameMatch = options.exact ? "AND symbol_name = ?" : "AND (symbol_name LIKE ? ESCAPE '\\')";
      const sql = `
        SELECT file_path, symbol_kind, symbol_name, qualified_name, line
        FROM symbols
        WHERE artifact_id = ?
          AND (symbol_kind = ? OR ? = '')
          ${nameMatch}
          AND (
            symbol_name > ?
            OR (symbol_name = ? AND file_path > ?)
            OR (symbol_name = ? AND file_path = ? AND line > ?)
          )
        ORDER BY symbol_name ASC, file_path ASC, line ASC
        LIMIT ?
      `;
      const nameParam = options.exact ? symbolName : `${symbolName}%`;
      rows = this.db.prepare(sql).all(
        options.artifactId,
        options.symbolKind ?? "",
        options.symbolKind ?? "",
        nameParam,
        cursor.symbolName,
        cursor.symbolName, cursor.filePath,
        cursor.symbolName, cursor.filePath, cursor.line,
        Math.max(1, fetchLimit)
      ) as SymbolQueryRow[];
    } else {
      const queryRows = options.exact ? this.searchExactStmt : this.searchStmt;
      rows = queryRows.all(
        options.artifactId,
        options.symbolKind ?? "",
        options.symbolKind ?? "",
        options.exact ? symbolName : `${symbolName}%`,
        Math.max(1, fetchLimit)
      ) as SymbolQueryRow[];
    }

    const page = rows.slice(0, options.limit);
    const hasMore = rows.length > options.limit;
    const nextCursor =
      page.length > 0 && hasMore
        ? encodeCursor(page[page.length - 1].symbol_name, page[page.length - 1].file_path, page[page.length - 1].line)
        : undefined;

    return {
      items: page.map((row) =>
        toSymbolRow(options.artifactId, {
          filePath: row.file_path,
          symbolKind: row.symbol_kind,
          symbolName: row.symbol_name,
          qualifiedName: row.qualified_name ?? undefined,
          line: row.line
        })
      ),
      nextCursor
    };
  }

  listSymbolsForArtifact(artifactId: string, symbolKind?: string): SymbolRow[] {
    const rows = (symbolKind
      ? this.listByArtifactKindStmt.all(artifactId, symbolKind)
      : this.listByArtifactStmt.all(artifactId)) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    return rows.map((row) =>
      toSymbolRow(artifactId, {
        filePath: row.file_path,
        symbolKind: row.symbol_kind,
        symbolName: row.symbol_name,
        qualifiedName: row.qualified_name ?? undefined,
        line: row.line
      })
    );
  }

  listSymbolsForFile(artifactId: string, filePath: string): SymbolRow[] {
    const rows = this.listByFileStmt.all(artifactId, filePath) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    return rows.map((row) =>
      toSymbolRow(artifactId, {
        filePath: row.file_path,
        symbolKind: row.symbol_kind,
        symbolName: row.symbol_name,
        qualifiedName: row.qualified_name ?? undefined,
        line: row.line
      })
    );
  }

  listSymbolsForFiles(
    artifactId: string,
    filePaths: string[],
    symbolKind?: string
  ): Map<string, SymbolRow[]> {
    const uniqueFilePaths = [...new Set(filePaths)];
    if (uniqueFilePaths.length === 0) {
      return new Map();
    }

    const placeholders = uniqueFilePaths.map(() => "?").join(", ");
    const sql = `
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
        AND file_path IN (${placeholders})
        ${symbolKind ? "AND symbol_kind = ?" : ""}
      ORDER BY file_path ASC, line ASC, symbol_name ASC
    `;
    const params = symbolKind ? [artifactId, ...uniqueFilePaths, symbolKind] : [artifactId, ...uniqueFilePaths];
    const rows = this.db.prepare(sql).all(...params) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    const byFile = new Map<string, SymbolRow[]>();
    for (const row of rows) {
      const bucket = byFile.get(row.file_path) ?? [];
      bucket.push(
        toSymbolRow(artifactId, {
          filePath: row.file_path,
          symbolKind: row.symbol_kind,
          symbolName: row.symbol_name,
          qualifiedName: row.qualified_name ?? undefined,
          line: row.line
        })
      );
      byFile.set(row.file_path, bucket);
    }

    return byFile;
  }

  findBySymbolNames(artifactId: string, symbolNames: string[]): SymbolRow[] {
    const unique = [...new Set(symbolNames.map((name) => name.trim()).filter(Boolean))];
    if (unique.length === 0) {
      return [];
    }

    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT file_path, symbol_kind, symbol_name, qualified_name, line
        FROM symbols
        WHERE artifact_id = ?
          AND lower(symbol_name) IN (${placeholders})
        ORDER BY symbol_name ASC, file_path ASC, line ASC
      `)
      .all(artifactId, ...unique.map((name) => name.toLowerCase())) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    return rows.map((row) =>
      toSymbolRow(artifactId, {
        filePath: row.file_path,
        symbolKind: row.symbol_kind,
        symbolName: row.symbol_name,
        qualifiedName: row.qualified_name ?? undefined,
        line: row.line
      })
    );
  }

  findScopedSymbols(options: FindScopedSymbolsOptions): PagedResult<SymbolRow> {
    const normalizedQuery = options.query.trim();
    if (!normalizedQuery) {
      return { items: [], nextCursor: undefined };
    }
    const normalizedLowerQuery = normalizedQuery.toLowerCase();
    const escapedLowerQuery = escapeLikeLiteral(normalizedLowerQuery);

    const params: unknown[] = [options.artifactId];
    const where: string[] = [];
    if (options.symbolKind) {
      where.push("symbol_kind = ?");
      params.push(options.symbolKind);
    }

    if (options.packagePrefix?.trim()) {
      const normalizedPrefix = options.packagePrefix.replace(/\.+/g, "/").replace(/\/+$/, "");
      where.push("file_path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikeLiteral(normalizedPrefix)}/%`);
    }

    if (options.filePathLike?.trim()) {
      where.push("file_path LIKE ? ESCAPE '\\'");
      params.push(options.filePathLike);
    }

    if (options.match === "exact") {
      where.push("symbol_name = ?");
      params.push(normalizedQuery);
    } else if (options.match === "prefix") {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`${escapedLowerQuery}%`);
    } else {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`%${escapedLowerQuery}%`);
    }

    if (options.cursor) {
      where.push(`(
        symbol_name > ?
        OR (symbol_name = ? AND file_path > ?)
        OR (symbol_name = ? AND file_path = ? AND line > ?)
      )`);
      params.push(
        options.cursor.symbolName,
        options.cursor.symbolName, options.cursor.filePath,
        options.cursor.symbolName, options.cursor.filePath, options.cursor.line
      );
    }

    const rawLimit = Math.max(1, options.limit ?? 5000);
    const fetchLimit = rawLimit + 1;
    params.push(fetchLimit);
    const sql = `
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
      ${where.length > 0 ? `AND ${where.join("\n      AND ")}` : ""}
      ORDER BY symbol_name ASC, file_path ASC, line ASC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    const hasMore = rows.length > rawLimit;
    const page = hasMore ? rows.slice(0, rawLimit) : rows;
    const lastRow = page.length > 0 ? page[page.length - 1] : undefined;
    const nextCursor = hasMore && lastRow
      ? encodeCursor(lastRow.symbol_name, lastRow.file_path, lastRow.line)
      : undefined;

    return {
      items: page.map((row) =>
        toSymbolRow(options.artifactId, {
          filePath: row.file_path,
          symbolKind: row.symbol_kind,
          symbolName: row.symbol_name,
          qualifiedName: row.qualified_name ?? undefined,
          line: row.line
        })
      ),
      nextCursor
    };
  }

  countScopedSymbols(options: {
    artifactId: string;
    query: string;
    match: ScopedSymbolMatch;
    symbolKind?: string;
    packagePrefix?: string;
  }): number {
    const normalizedQuery = options.query.trim();
    if (!normalizedQuery) {
      return 0;
    }
    const normalizedLowerQuery = normalizedQuery.toLowerCase();
    const escapedLowerQuery = escapeLikeLiteral(normalizedLowerQuery);

    const params: unknown[] = [options.artifactId];
    const where: string[] = [];
    if (options.symbolKind) {
      where.push("symbol_kind = ?");
      params.push(options.symbolKind);
    }
    if (options.packagePrefix?.trim()) {
      const normalizedPrefix = options.packagePrefix.replace(/\.+/g, "/").replace(/\/+$/, "");
      where.push("file_path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikeLiteral(normalizedPrefix)}/%`);
    }
    if (options.match === "exact") {
      where.push("symbol_name = ?");
      params.push(normalizedQuery);
    } else if (options.match === "prefix") {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`${escapedLowerQuery}%`);
    } else {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`%${escapedLowerQuery}%`);
    }

    const sql = `
      SELECT COUNT(*) AS cnt
      FROM symbols
      WHERE artifact_id = ?
      ${where.length > 0 ? `AND ${where.join("\n      AND ")}` : ""}
    `;
    const row = this.db.prepare(sql).get(...params) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  listDistinctFilePathsByKind(artifactId: string, symbolKind: string): string[] {
    const rows = this.db
      .prepare(`
        SELECT DISTINCT file_path
        FROM symbols
        WHERE artifact_id = ? AND symbol_kind = ?
        ORDER BY file_path ASC
      `)
      .all(artifactId, symbolKind) as { file_path: string }[];
    return rows.map((row) => row.file_path);
  }

  findBestClassFilePath(artifactId: string, className: string, simpleName: string): string | undefined {
    const normalizedClassName = className.trim();
    const normalizedSimpleName = simpleName.trim();
    if (!normalizedClassName || !normalizedSimpleName) {
      return undefined;
    }

    const row = this.db
      .prepare(`
        SELECT file_path
        FROM symbols
        WHERE artifact_id = ?
          AND symbol_kind = 'class'
          AND (
            qualified_name = ?
            OR symbol_name = ?
            OR qualified_name LIKE ?
          )
        ORDER BY
          CASE
            WHEN qualified_name = ? THEN 0
            WHEN symbol_name = ? THEN 1
            ELSE 2
          END,
          file_path ASC
        LIMIT 1
      `)
      .get(
        artifactId,
        normalizedClassName,
        normalizedSimpleName,
        `%.${normalizedSimpleName}`,
        normalizedClassName,
        normalizedSimpleName
      ) as { file_path?: string } | undefined;

    return row?.file_path;
  }
}
