import { resolve as resolvePath } from "node:path";

import { LruList } from "./lru-list.js";
import type { SourceMapping } from "./types.js";
import type { WorkspaceProjectLoader } from "./workspace-mapping-service.js";

export type WorkspaceContextEvidence = {
  source: string;
  field: string;
  value?: string;
};

export type WorkspaceContext = {
  projectPath: string;
  minecraftVersion?: string;
  compileMapping?: SourceMapping;
  loader?: WorkspaceProjectLoader;
  detectedAt: number;
  evidence: WorkspaceContextEvidence[];
  dependencyVersions: Map<string, string>;
  partial?: boolean;
};

export interface WorkspaceContextCache {
  read(projectPath: string): WorkspaceContext | undefined;
  write(ctx: WorkspaceContext): void;
  invalidate(projectPath: string): boolean;
  list(): WorkspaceContext[];
  clear(): void;
}

export type WorkspaceContextCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  clock?: () => number;
};

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_TTL_MS = 5 * 60_000;

function normalizeKey(projectPath: string): string {
  return resolvePath(projectPath);
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
      if (isExpired(value)) {
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
      return all.filter((value) => !isExpired(value));
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

export function resetProcessWorkspaceContextCacheForTesting(): void {
  processCache = undefined;
}
