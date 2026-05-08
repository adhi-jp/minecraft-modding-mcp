/**
 * Mutable per-instance state shared across SourceService domain modules
 * (cache metrics, indexer, binary remap). Wrapped in a small class so
 * sibling modules can read and reassign fields without dropping `private`
 * on every individual member of `SourceService`.
 */

import { LruList } from "../lru-list.js";

export class SourceServiceState {
  cacheTotalContentBytes = 0;
  readonly remappedJarBytes = new Map<string, number>();
  /**
   * In-flight binary-remap jobs keyed by remapped jar path so concurrent
   * resolveArtifact calls for the same artifactId share a single
   * tiny-remapper run.
   */
  readonly inflightRemaps = new Map<string, Promise<string>>();
  readonly lru = new LruList<{ totalContentBytes: number; updatedAt: string }>();
}
