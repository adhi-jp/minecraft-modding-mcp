/**
 * Cache-byte and LRU accounting for SourceService. Pure free functions
 * operating on the SourceService instance via its public infrastructure
 * fields and SourceServiceState wrapper. Behavior-preserving extraction
 * from `src/source-service.ts`.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { log } from "../logger.js";
import type { SourceService } from "../source-service.js";

export function hasAnyFiles(svc: SourceService, artifactId: string): boolean {
  return svc.filesRepo.listFiles(artifactId, { limit: 1 }).items.length > 0;
}

/**
 * Best-effort cleanup of `<cacheDir>/remapped/<artifactId>.jar` written by
 * the binary-remap path. Called from cache-eviction so the Mojang-remapped
 * binary jar does not outlive the artifact row that owns it. Also releases
 * the jar's bytes from `state.cacheTotalContentBytes`. Errors are
 * swallowed: orphaned jars remain visible to `manage-cache` under the
 * `binary-remap` cache kind and can be reclaimed there.
 */
export function unlinkRemappedJarForArtifact(svc: SourceService, artifactId: string): void {
  releaseRemappedJarBytes(svc, artifactId);
  const remappedJarPath = join(svc.config.cacheDir, "remapped", `${artifactId}.jar`);
  try {
    if (existsSync(remappedJarPath)) {
      unlinkSync(remappedJarPath);
    }
  } catch {
    // ignore: orphaned jar is still reclaimable via manage-cache binary-remap kind.
  }
}

/**
 * Add the remapped jar's on-disk size to `state.cacheTotalContentBytes` so
 * the `enforceCacheLimits` byte gate sees the jar before deciding to evict.
 * Without this, a Mojang-remapped client jar (tens of MB) can accumulate
 * silently while the indexed-source byte total stays below `maxCacheBytes`.
 */
export function recordRemappedJarBytes(svc: SourceService, artifactId: string, sizeBytes: number): void {
  const normalized = Math.max(0, Math.trunc(sizeBytes));
  const existing = svc.state.remappedJarBytes.get(artifactId) ?? 0;
  svc.state.cacheTotalContentBytes = Math.max(
    0,
    svc.state.cacheTotalContentBytes - existing + normalized
  );
  svc.state.remappedJarBytes.set(artifactId, normalized);
  publishCacheMetrics(svc);
}

export function releaseRemappedJarBytes(svc: SourceService, artifactId: string): void {
  const existing = svc.state.remappedJarBytes.get(artifactId);
  if (!existing) {
    return;
  }
  svc.state.cacheTotalContentBytes = Math.max(0, svc.state.cacheTotalContentBytes - existing);
  svc.state.remappedJarBytes.delete(artifactId);
  publishCacheMetrics(svc);
}

export function enforceCacheLimits(svc: SourceService): void {
  let artifactCount = svc.state.lru.size;
  let totalBytes = svc.state.cacheTotalContentBytes;
  if (artifactCount <= svc.config.maxArtifacts && totalBytes <= svc.config.maxCacheBytes) {
    return;
  }

  const candidates = svc.state.lru.toArray();
  for (const candidate of candidates) {
    const shouldEvict = artifactCount > svc.config.maxArtifacts || totalBytes > svc.config.maxCacheBytes;
    if (!shouldEvict || artifactCount <= 1) {
      break;
    }

    const artifactCountBefore = artifactCount;
    const totalBytesBefore = totalBytes;
    const remappedBytesForCandidate = svc.state.remappedJarBytes.get(candidate.key) ?? 0;
    svc.filesRepo.deleteFilesForArtifact(candidate.key);
    svc.artifactsRepo.deleteArtifact(candidate.key);
    unlinkRemappedJarForArtifact(svc, candidate.key);
    removeCacheMetrics(svc, candidate.key, false);
    artifactCount = Math.max(0, artifactCount - 1);
    totalBytes = Math.max(
      0,
      totalBytes - candidate.value.totalContentBytes - remappedBytesForCandidate
    );
    svc.metrics.recordCacheEviction();
    log("warn", "cache.evict", {
      artifactId: candidate.key,
      artifactCountBefore,
      totalBytesBefore,
      artifactBytes: candidate.value.totalContentBytes + remappedBytesForCandidate
    });
  }

  publishCacheMetrics(svc);
}

export function refreshCacheMetrics(svc: SourceService): void {
  const cacheEntries = svc.artifactsRepo.countArtifacts();
  const totalContentBytes = svc.artifactsRepo.totalContentBytes();
  const lruAccounting = svc.artifactsRepo.listArtifactsByLruWithContentBytes(Math.max(cacheEntries, 1));

  svc.state.lru.clear();
  for (const row of lruAccounting) {
    svc.state.lru.upsert(row.artifactId, {
      totalContentBytes: row.totalContentBytes,
      updatedAt: row.updatedAt
    });
  }
  svc.state.remappedJarBytes.clear();
  let remappedTotal = 0;
  const remappedDir = join(svc.config.cacheDir, "remapped");
  if (existsSync(remappedDir)) {
    // Only count remapped jars whose owning artifact is still in the LRU set.
    // Orphaned jars (artifact deleted, prior unlink lost a race, externally
    // placed) stay visible to manage-cache under the `binary-remap` kind
    // for prune, but must not be folded into `cacheTotalContentBytes` here:
    // enforceCacheLimits cannot evict them, so counting their bytes would
    // force unrelated live artifacts to be evicted to chase orphan bytes.
    const liveArtifactIds = new Set(svc.state.lru.toArray().map((entry) => entry.key));
    try {
      for (const entry of readdirSync(remappedDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jar")) {
          continue;
        }
        const artifactId = entry.name.slice(0, -".jar".length);
        if (!liveArtifactIds.has(artifactId)) {
          continue;
        }
        try {
          const fileStat = statSync(join(remappedDir, entry.name));
          const size = Math.max(0, Math.trunc(fileStat.size));
          svc.state.remappedJarBytes.set(artifactId, size);
          remappedTotal += size;
        } catch {
          // ignore stat failure on a single jar; total stays best-effort.
        }
      }
    } catch {
      // ignore listing failure; remapped accounting stays empty until next remap.
    }
  }
  svc.state.cacheTotalContentBytes = totalContentBytes + remappedTotal;
  publishCacheMetrics(svc);
}

export function touchCacheMetrics(svc: SourceService, artifactId: string, updatedAt: string): void {
  const entry = svc.state.lru.touch(artifactId);
  if (!entry) {
    refreshCacheMetrics(svc);
    return;
  }
  entry.updatedAt = updatedAt;
  publishCacheMetrics(svc);
}

export function upsertCacheMetrics(svc: SourceService, artifactId: string, totalContentBytes: number, updatedAt: string): void {
  const normalizedBytes = Math.max(0, Math.trunc(totalContentBytes));
  const existing = svc.state.lru.remove(artifactId);
  if (existing) {
    svc.state.cacheTotalContentBytes = Math.max(
      0,
      svc.state.cacheTotalContentBytes - existing.totalContentBytes + normalizedBytes
    );
  } else {
    svc.state.cacheTotalContentBytes += normalizedBytes;
  }
  svc.state.lru.upsert(artifactId, { totalContentBytes: normalizedBytes, updatedAt });
  publishCacheMetrics(svc);
}

export function removeCacheMetrics(svc: SourceService, artifactId: string, publish = true): void {
  const existing = svc.state.lru.remove(artifactId);
  if (!existing) {
    refreshCacheMetrics(svc);
    return;
  }
  svc.state.cacheTotalContentBytes = Math.max(0, svc.state.cacheTotalContentBytes - existing.totalContentBytes);
  if (publish) {
    publishCacheMetrics(svc);
  }
}

export function publishCacheMetrics(svc: SourceService): void {
  svc.metrics.setCacheEntries(svc.state.lru.size);
  svc.metrics.setCacheTotalContentBytes(svc.state.cacheTotalContentBytes);
}

export function snapshotLruAccounting(svc: SourceService): void {
  svc.metrics.setCacheArtifactByteAccountingRef(
    svc.state.lru.toArray().map(({ key, value }) => ({
      artifactId: key,
      totalContentBytes: value.totalContentBytes,
      updatedAt: value.updatedAt
    }))
  );
}
