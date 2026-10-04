import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { LruList } from "./lru-list.js";
import type { SourceMapping } from "./types.js";
import type { WorkspaceProjectLoader } from "./workspace-mapping-service.js";

type WorkspaceContextEvidence = {
  source: string;
  field: string;
  value?: string;
};

/**
 * A stat-based snapshot of one file the detection that produced a
 * `WorkspaceContext` actually read, taken at write time. `read()` re-stats
 * every entry and treats any difference - a changed mtime/size, a file that
 * appeared, or one that disappeared - as a cache miss, so an edit to a
 * project's build files invalidates the cached context immediately instead
 * of waiting out the TTL.
 */
type WorkspaceContextFingerprintEntry =
  | { path: string; mtimeMs: number; size: number }
  | { path: string; absent: true };

export type WorkspaceContext = {
  projectPath: string;
  minecraftVersion?: string;
  compileMapping?: SourceMapping;
  loader?: WorkspaceProjectLoader;
  detectedAt: number;
  evidence: WorkspaceContextEvidence[];
  dependencyVersions: Map<string, string>;
  partial?: boolean;
  fingerprint?: WorkspaceContextFingerprintEntry[];
};

export interface WorkspaceContextCache {
  read(projectPath: string): WorkspaceContext | undefined;
  write(ctx: WorkspaceContext): void;
  invalidate(projectPath: string): boolean;
  list(): WorkspaceContext[];
  clear(): void;
}

type WorkspaceContextCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  clock?: () => number;
};

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_TTL_MS = 5 * 60_000;

function normalizeKey(projectPath: string): string {
  return resolvePath(projectPath);
}

function currentFingerprintEntry(path: string): WorkspaceContextFingerprintEntry {
  try {
    const stats = statSync(path);
    return { path, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    // Missing, unreadable, or a broken symlink - all the same "not there"
    // state as far as invalidation cares about.
    return { path, absent: true };
  }
}

/**
 * Stat-snapshot the given file paths (deduplicated, order-independent) for a
 * `WorkspaceContext.fingerprint`. Exported so the workspace-context populator
 * (the only place that knows which files a detection actually read) can build
 * the same shape `read()` compares against, without duplicating the stat
 * logic or its absent-file handling.
 */
export function computeWorkspaceContextFingerprint(
  paths: readonly string[]
): WorkspaceContextFingerprintEntry[] {
  const unique = Array.from(new Set(paths.map((path) => resolvePath(path))));
  return unique.map((path) => currentFingerprintEntry(path));
}

/**
 * Whether any file recorded in `ctx.fingerprint` no longer matches its
 * recorded size/mtime (or its recorded/current absence disagrees). A context
 * with no fingerprint (nothing was recorded, e.g. a dependency-only partial
 * entry) never invalidates on this check - only the TTL applies to it.
 */
function fingerprintStale(ctx: WorkspaceContext): boolean {
  if (!ctx.fingerprint || ctx.fingerprint.length === 0) {
    return false;
  }
  for (const recorded of ctx.fingerprint) {
    const current = currentFingerprintEntry(recorded.path);
    const recordedAbsent = "absent" in recorded && recorded.absent === true;
    const currentAbsent = "absent" in current && current.absent === true;
    if (recordedAbsent !== currentAbsent) {
      return true;
    }
    if (!recordedAbsent && !currentAbsent) {
      const recordedStat = recorded as { mtimeMs: number; size: number };
      const currentStat = current as { mtimeMs: number; size: number };
      if (recordedStat.mtimeMs !== currentStat.mtimeMs || recordedStat.size !== currentStat.size) {
        return true;
      }
    }
  }
  return false;
}

export function createWorkspaceContextCache(
  opts: WorkspaceContextCacheOptions = {}
): WorkspaceContextCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock = opts.clock ?? (() => Date.now());

  const lru = new LruList<WorkspaceContext>();

  function isExpired(ctx: WorkspaceContext): boolean {
    return clock() - ctx.detectedAt > ttlMs;
  }

  function evictExcess(): void {
    while (lru.size > maxEntries) {
      const oldest = lru.peekOldest();
      if (!oldest) {
        return;
      }
      lru.remove(oldest.key);
    }
  }

  return {
    read(projectPath: string): WorkspaceContext | undefined {
      const key = normalizeKey(projectPath);
      const value = lru.touch(key);
      if (!value) {
        return undefined;
      }
      if (isExpired(value) || fingerprintStale(value)) {
        lru.remove(key);
        return undefined;
      }
      return value;
    },
    write(ctx: WorkspaceContext): void {
      const key = normalizeKey(ctx.projectPath);
      lru.upsert(key, { ...ctx, projectPath: key });
      evictExcess();
    },
    invalidate(projectPath: string): boolean {
      const key = normalizeKey(projectPath);
      return lru.remove(key) !== undefined;
    },
    list(): WorkspaceContext[] {
      const all = lru.toArray().map((entry) => entry.value);
      return all.filter((value) => !isExpired(value) && !fingerprintStale(value));
    },
    clear(): void {
      lru.clear();
    }
  };
}

let processCache: WorkspaceContextCache | undefined;

export function getProcessWorkspaceContextCache(): WorkspaceContextCache {
  if (!processCache) {
    processCache = createWorkspaceContextCache();
  }
  return processCache;
}
