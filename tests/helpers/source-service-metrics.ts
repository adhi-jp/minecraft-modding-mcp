/**
 * Runtime-metrics readers shared between source-service test slices.
 * Each helper reads a typed subset of `service.getRuntimeMetrics()` and
 * returns sentinel values (-1) when the field is missing or wrong-typed.
 */

type HasMetrics = { getRuntimeMetrics: () => unknown };

export function readSearchPathMetrics(service: HasMetrics): {
  indexedHits: number;
  fallbackHits: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    indexedHits:
      typeof snapshot.search_indexed_hit_count === "number"
        ? snapshot.search_indexed_hit_count
        : -1,
    fallbackHits:
      typeof snapshot.search_fallback_count === "number"
        ? snapshot.search_fallback_count
        : -1
  };
}

export function readSearchIoMetrics(service: HasMetrics): {
  dbRoundtrips: number;
  rowsScanned: number;
  rowsReturned: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    dbRoundtrips:
      typeof snapshot.search_db_roundtrips === "number"
        ? snapshot.search_db_roundtrips
        : -1,
    rowsScanned:
      typeof snapshot.search_rows_scanned === "number"
        ? snapshot.search_rows_scanned
        : -1,
    rowsReturned:
      typeof snapshot.search_rows_returned === "number"
        ? snapshot.search_rows_returned
        : -1
  };
}

export function readSearchModeMetrics(service: HasMetrics): {
  autoCount: number;
  tokenCount: number;
  literalCount: number;
  explicitLiteralCount: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  return {
    autoCount:
      typeof snapshot.search_query_mode_auto_count === "number"
        ? snapshot.search_query_mode_auto_count
        : -1,
    tokenCount:
      typeof snapshot.search_query_mode_token_count === "number"
        ? snapshot.search_query_mode_token_count
        : -1,
    literalCount:
      typeof snapshot.search_query_mode_literal_count === "number"
        ? snapshot.search_query_mode_literal_count
        : -1,
    explicitLiteralCount:
      typeof snapshot.search_literal_explicit_count === "number"
        ? snapshot.search_literal_explicit_count
        : -1
  };
}

export function readListFilesDurationMetric(service: HasMetrics): {
  count: number;
  totalMs: number;
  lastMs: number;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  const raw = snapshot.list_files_duration_ms;
  if (typeof raw !== "object" || raw === null) {
    return { count: -1, totalMs: -1, lastMs: -1 };
  }

  const metric = raw as Record<string, unknown>;
  return {
    count: typeof metric.count === "number" ? metric.count : -1,
    totalMs: typeof metric.totalMs === "number" ? metric.totalMs : -1,
    lastMs: typeof metric.lastMs === "number" ? metric.lastMs : -1
  };
}

export function readCacheAccountingMetrics(service: HasMetrics): {
  cacheEntries: number;
  totalContentBytes: number;
  lru: Array<{ artifactId: string; contentBytes: number; updatedAt: string }>;
} {
  const snapshot = service.getRuntimeMetrics() as Record<string, unknown>;
  const rawRows = Array.isArray(snapshot.cache_artifact_bytes_lru)
    ? snapshot.cache_artifact_bytes_lru
    : [];
  return {
    cacheEntries: typeof snapshot.cache_entries === "number" ? snapshot.cache_entries : -1,
    totalContentBytes:
      typeof snapshot.cache_total_content_bytes === "number"
        ? snapshot.cache_total_content_bytes
        : -1,
    lru: rawRows
      .map((row) => {
        if (typeof row !== "object" || row === null) {
          return undefined;
        }
        const asRecord = row as Record<string, unknown>;
        const artifactId = asRecord.artifact_id;
        const contentBytes = asRecord.content_bytes;
        const updatedAt = asRecord.updated_at;
        if (
          typeof artifactId !== "string" ||
          typeof contentBytes !== "number" ||
          typeof updatedAt !== "string"
        ) {
          return undefined;
        }
        return { artifactId, contentBytes, updatedAt };
      })
      .filter((row): row is { artifactId: string; contentBytes: number; updatedAt: string } => row != null)
  };
}
