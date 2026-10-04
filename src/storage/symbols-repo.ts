import Database from "./sqlite.js";
import type { SymbolRow } from "../types.js";

type SqliteDatabase = InstanceType<typeof Database>;

export interface IndexedSymbol {
  filePath: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

type ScopedSymbolMatch = "exact" | "prefix" | "contains";

export interface FindScopedSymbolsOptions {
  artifactId: string;
  query: string;
  match: ScopedSymbolMatch;
  symbolKind?: string;
  /**
   * Restrict results to these symbol kinds via a bound `symbol_kind IN (...)` clause.
   * Combined with the singular `symbolKind` it ANDs (both apply). An empty array is
   * ignored (degrades to no kind filter) to avoid emitting an invalid `IN ()`.
   */
  symbolKinds?: string[];
  packagePrefix?: string;
  filePathLike?: string;
  limit?: number;
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

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class SymbolsRepo {
  private readonly deleteStmt;
  private readonly insertStmt;
  private readonly listByArtifactStmt;
  private readonly listByArtifactKindStmt;
  // Dynamic WHERE-clause builders produce a small bounded set of SQL strings;
  // cache their prepared statements (LRU by SQL text) instead of re-preparing per call.
  private readonly dynamicStmtCache = new Map<string, ReturnType<SqliteDatabase["prepare"]>>();
  private static readonly DYNAMIC_STMT_CACHE_MAX = 64;

  constructor(private readonly db: SqliteDatabase) {
    this.deleteStmt = this.db.prepare(`
      DELETE FROM symbols WHERE artifact_id = ?
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO symbols (artifact_id, file_path, symbol_kind, symbol_name, qualified_name, line)
      VALUES (?, ?, ?, ?, ?, ?)
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
  }

  private prepareCached(sql: string): ReturnType<SqliteDatabase["prepare"]> {
    const cached = this.dynamicStmtCache.get(sql);
    if (cached) {
      // Refresh recency so hot statements survive eviction.
      this.dynamicStmtCache.delete(sql);
      this.dynamicStmtCache.set(sql, cached);
      return cached;
    }
    const stmt = this.db.prepare(sql);
    this.dynamicStmtCache.set(sql, stmt);
    if (this.dynamicStmtCache.size > SymbolsRepo.DYNAMIC_STMT_CACHE_MAX) {
      const oldest = this.dynamicStmtCache.keys().next().value;
      if (oldest !== undefined) this.dynamicStmtCache.delete(oldest);
    }
    return stmt;
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

  /**
   * Streams an artifact's symbols: rows are mapped lazily so callers
   * that filter (e.g. regex symbol search) never materialize the full symbol set.
   * Do not run other statements on this connection while consuming the iterator.
   */
  *iterateSymbolsForArtifact(artifactId: string, symbolKind?: string): IterableIterator<SymbolRow> {
    const rows = (symbolKind
      ? this.listByArtifactKindStmt.iterate(artifactId, symbolKind)
      : this.listByArtifactStmt.iterate(artifactId)) as Iterable<{
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }>;

    for (const row of rows) {
      yield toSymbolRow(artifactId, {
        filePath: row.file_path,
        symbolKind: row.symbol_kind,
        symbolName: row.symbol_name,
        qualifiedName: row.qualified_name ?? undefined,
        line: row.line
      });
    }
  }

  findScopedSymbols(options: FindScopedSymbolsOptions): { items: SymbolRow[] } {
    const normalizedQuery = options.query.trim();
    if (!normalizedQuery) {
      return { items: [] };
    }
    const normalizedLowerQuery = normalizedQuery.toLowerCase();
    const escapedLowerQuery = escapeLikeLiteral(normalizedLowerQuery);

    const params: unknown[] = [options.artifactId];
    const where: string[] = [];
    if (options.symbolKind) {
      where.push("symbol_kind = ?");
      params.push(options.symbolKind);
    }

    const symbolKinds = options.symbolKinds;
    if (symbolKinds && symbolKinds.length > 0) {
      const placeholders = symbolKinds.map(() => "?").join(", ");
      where.push(`symbol_kind IN (${placeholders})`);
      params.push(...symbolKinds);
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
      // The lower() predicate is implied by the case-sensitive equality and never
      // changes the result; it lets the planner use the lower(symbol_name) indexes
      // instead of scanning every symbol of the artifact. Both sides fold through
      // SQLite's lower() (ASCII-only), so non-ASCII capitals still match.
      where.push("lower(symbol_name) = lower(?)");
      params.push(normalizedQuery);
      where.push("symbol_name = ?");
      params.push(normalizedQuery);
    } else if (options.match === "prefix") {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`${escapedLowerQuery}%`);
    } else {
      where.push("lower(symbol_name) LIKE ? ESCAPE '\\'");
      params.push(`%${escapedLowerQuery}%`);
    }

    params.push(Math.max(1, options.limit ?? 5000));
    const sql = `
      SELECT file_path, symbol_kind, symbol_name, qualified_name, line
      FROM symbols
      WHERE artifact_id = ?
      ${where.length > 0 ? `AND ${where.join("\n      AND ")}` : ""}
      ORDER BY symbol_name ASC, file_path ASC, line ASC
      LIMIT ?
    `;
    const rows = this.prepareCached(sql).all(...params) as {
      file_path: string;
      symbol_kind: string;
      symbol_name: string;
      qualified_name: string | null;
      line: number;
    }[];

    return {
      items: rows.map((row) =>
        toSymbolRow(options.artifactId, {
          filePath: row.file_path,
          symbolKind: row.symbol_kind,
          symbolName: row.symbol_name,
          qualifiedName: row.qualified_name ?? undefined,
          line: row.line
        })
      )
    };
  }
}
