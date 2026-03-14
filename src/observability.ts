export interface MetricTimingSnapshot {
  count: number;
  totalMs: number;
  avgMs: number;
  lastMs: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CacheArtifactByteAccountingRow {
  artifact_id: string;
  content_bytes: number;
  updated_at: string;
}

type CacheArtifactByteAccountingRefRow = {
  artifactId: string;
  totalContentBytes: number;
  updatedAt: string;
};

export interface RuntimeMetricSnapshot {
  resolve_duration_ms: MetricTimingSnapshot;
  search_duration_ms: MetricTimingSnapshot;
  get_file_duration_ms: MetricTimingSnapshot;
  list_files_duration_ms: MetricTimingSnapshot;
  decompile_duration_ms: MetricTimingSnapshot;
  search_intent_symbol_duration_ms: MetricTimingSnapshot;
  search_intent_text_duration_ms: MetricTimingSnapshot;
  search_intent_path_duration_ms: MetricTimingSnapshot;
  search_query_mode_auto_count: number;
  search_query_mode_token_count: number;
  search_query_mode_literal_count: number;
  search_literal_explicit_count: number;
  search_regex_fallback_count: number;
  search_token_bytes_returned: number;
  onehop_expand_count: number;
  search_indexed_hit_count: number;
  search_fallback_count: number;
  indexed_disabled_count: number;
  search_db_roundtrips: number;
  search_rows_scanned: number;
  search_rows_returned: number;
  search_indexed_zero_shortcircuit_count: number;
  reindex_count: number;
  reindex_skip_count: number;
  cache_evictions: number;
  cache_entries: number;
  cache_total_content_bytes: number;
  cache_artifact_bytes_lru: CacheArtifactByteAccountingRow[];
  cache_hit_rate: number;
  repo_failover_count: number;
}

type DurationMetricName = keyof Pick<
  RuntimeMetricSnapshot,
  | "resolve_duration_ms"
  | "search_duration_ms"
  | "get_file_duration_ms"
  | "list_files_duration_ms"
  | "decompile_duration_ms"
  | "search_intent_symbol_duration_ms"
  | "search_intent_text_duration_ms"
  | "search_intent_path_duration_ms"
>;

interface DurationState {
  count: number;
  totalMs: number;
  lastMs: number;
  samples: number[];
}

const MAX_TIMING_SAMPLES = 512;

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export class RuntimeMetrics {
  private readonly timings = new Map<DurationMetricName, DurationState>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private repoFailoverCount = 0;
  private searchQueryModeAutoCount = 0;
  private searchQueryModeTokenCount = 0;
  private searchQueryModeLiteralCount = 0;
  private searchLiteralExplicitCount = 0;
  private searchRegexFallbackCount = 0;
  private searchTokenBytesReturned = 0;
  private oneHopExpandCount = 0;
  private searchIndexedHitCount = 0;
  private searchFallbackCount = 0;
  private indexedDisabledCount = 0;
  private searchDbRoundtrips = 0;
  private searchRowsScanned = 0;
  private searchRowsReturned = 0;
  private searchIndexedZeroShortcircuitCount = 0;
  private reindexCount = 0;
  private reindexSkipCount = 0;
  private cacheEvictions = 0;
  private cacheEntries = 0;
  private cacheTotalContentBytes = 0;
  private cacheArtifactBytesLruRef: ReadonlyArray<CacheArtifactByteAccountingRefRow> = [];

  constructor() {
    const names: DurationMetricName[] = [
      "resolve_duration_ms",
      "search_duration_ms",
      "get_file_duration_ms",
      "list_files_duration_ms",
      "decompile_duration_ms",
      "search_intent_symbol_duration_ms",
      "search_intent_text_duration_ms",
      "search_intent_path_duration_ms"
    ];
    for (const name of names) {
      this.timings.set(name, { count: 0, totalMs: 0, lastMs: 0, samples: [] });
    }
  }

  recordDuration(name: DurationMetricName, durationMs: number): void {
    const timing = this.timings.get(name);
    if (!timing) {
      return;
    }

    const normalizedDuration = Math.max(0, Math.trunc(durationMs));
    timing.count += 1;
    timing.totalMs += normalizedDuration;
    timing.lastMs = normalizedDuration;
    timing.samples.push(normalizedDuration);
    if (timing.samples.length > MAX_TIMING_SAMPLES) {
      timing.samples.shift();
    }
  }

  recordArtifactCacheHit(): void {
    this.cacheHits += 1;
  }

  recordArtifactCacheMiss(): void {
    this.cacheMisses += 1;
  }

  recordRepoFailover(): void {
    this.repoFailoverCount += 1;
  }

  recordSearchQueryMode(mode: "auto" | "token" | "literal"): void {
    switch (mode) {
      case "auto":
        this.searchQueryModeAutoCount += 1;
        break;
      case "token":
        this.searchQueryModeTokenCount += 1;
        break;
      case "literal":
        this.searchQueryModeLiteralCount += 1;
        this.searchLiteralExplicitCount += 1;
        break;
    }
  }

  recordSearchIntentDuration(intent: "symbol" | "text" | "path", durationMs: number): void {
    const metricName =
      intent === "symbol"
        ? "search_intent_symbol_duration_ms"
        : intent === "text"
          ? "search_intent_text_duration_ms"
          : "search_intent_path_duration_ms";
    this.recordDuration(metricName, durationMs);
  }

  recordSearchRegexFallback(): void {
    this.searchRegexFallbackCount += 1;
  }

  recordSearchTokenBytesReturned(tokenBytes: number): void {
    this.searchTokenBytesReturned += Math.max(0, Math.trunc(tokenBytes));
  }

  recordOneHopExpansion(count: number): void {
    this.oneHopExpandCount += Math.max(0, Math.trunc(count));
  }

  recordSearchIndexedHit(): void {
    this.searchIndexedHitCount += 1;
  }

  recordSearchFallback(): void {
    this.searchFallbackCount += 1;
  }

  recordIndexedDisabled(): void {
    this.indexedDisabledCount += 1;
  }

  recordSearchDbRoundtrip(count = 1): void {
    this.searchDbRoundtrips += Math.max(0, Math.trunc(count));
  }

  recordSearchRowsScanned(count: number): void {
    this.searchRowsScanned += Math.max(0, Math.trunc(count));
  }

  recordSearchRowsReturned(count: number): void {
    this.searchRowsReturned += Math.max(0, Math.trunc(count));
  }

  recordSearchIndexedZeroShortcircuit(): void {
    this.searchIndexedZeroShortcircuitCount += 1;
  }

  recordReindex(): void {
    this.reindexCount += 1;
  }

  recordReindexSkip(): void {
    this.reindexSkipCount += 1;
  }

  recordCacheEviction(count = 1): void {
    this.cacheEvictions += Math.max(0, Math.trunc(count));
  }

  setCacheEntries(entries: number): void {
    this.cacheEntries = Math.max(0, Math.trunc(entries));
  }

  setCacheTotalContentBytes(totalBytes: number): void {
    this.cacheTotalContentBytes = Math.max(0, Math.trunc(totalBytes));
  }

  setCacheArtifactByteAccountingRef(entries: ReadonlyArray<CacheArtifactByteAccountingRefRow>): void {
    this.cacheArtifactBytesLruRef = entries;
  }

  snapshot(): RuntimeMetricSnapshot {
    return {
      resolve_duration_ms: this.toSnapshot("resolve_duration_ms"),
      search_duration_ms: this.toSnapshot("search_duration_ms"),
      get_file_duration_ms: this.toSnapshot("get_file_duration_ms"),
      list_files_duration_ms: this.toSnapshot("list_files_duration_ms"),
      decompile_duration_ms: this.toSnapshot("decompile_duration_ms"),
      search_intent_symbol_duration_ms: this.toSnapshot("search_intent_symbol_duration_ms"),
      search_intent_text_duration_ms: this.toSnapshot("search_intent_text_duration_ms"),
      search_intent_path_duration_ms: this.toSnapshot("search_intent_path_duration_ms"),
      search_query_mode_auto_count: this.searchQueryModeAutoCount,
      search_query_mode_token_count: this.searchQueryModeTokenCount,
      search_query_mode_literal_count: this.searchQueryModeLiteralCount,
      search_literal_explicit_count: this.searchLiteralExplicitCount,
      search_regex_fallback_count: this.searchRegexFallbackCount,
      search_token_bytes_returned: this.searchTokenBytesReturned,
      onehop_expand_count: this.oneHopExpandCount,
      search_indexed_hit_count: this.searchIndexedHitCount,
      search_fallback_count: this.searchFallbackCount,
      indexed_disabled_count: this.indexedDisabledCount,
      search_db_roundtrips: this.searchDbRoundtrips,
      search_rows_scanned: this.searchRowsScanned,
      search_rows_returned: this.searchRowsReturned,
      search_indexed_zero_shortcircuit_count: this.searchIndexedZeroShortcircuitCount,
      reindex_count: this.reindexCount,
      reindex_skip_count: this.reindexSkipCount,
      cache_evictions: this.cacheEvictions,
      cache_entries: this.cacheEntries,
      cache_total_content_bytes: this.cacheTotalContentBytes,
      cache_artifact_bytes_lru: this.cacheArtifactBytesLruRef.map((entry) => ({
        artifact_id: entry.artifactId,
        content_bytes: Math.max(0, Math.trunc(entry.totalContentBytes)),
        updated_at: entry.updatedAt
      })),
      cache_hit_rate: this.resolveCacheHitRate(),
      repo_failover_count: this.repoFailoverCount
    };
  }

  private toSnapshot(name: DurationMetricName): MetricTimingSnapshot {
    const timing = this.timings.get(name);
    const count = timing?.count ?? 0;
    const totalMs = timing?.totalMs ?? 0;
    return {
      count,
      totalMs,
      avgMs: count > 0 ? totalMs / count : 0,
      lastMs: timing?.lastMs ?? 0,
      p95Ms: percentile(timing?.samples ?? [], 95),
      p99Ms: percentile(timing?.samples ?? [], 99)
    };
  }

  private resolveCacheHitRate(): number {
    const denominator = this.cacheHits + this.cacheMisses;
    if (denominator === 0) {
      return 0;
    }

    return this.cacheHits / denominator;
  }
}
