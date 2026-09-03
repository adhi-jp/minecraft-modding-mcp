import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import v8 from "node:v8";

import type { SourceMapping } from "../../types.js";
import type { PairKey } from "../internal-types.js";
import { pairKey } from "../parsers/normalize.js";
import { parseTinyHeader } from "../parsers/tiny.js";

/** Upper bound on the bytes read while sniffing a file's header line. */
const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * Bytes of JS heap one index slot costs, measured on Minecraft 1.21.10 loom
 * mappings (2,080 MB peak / 6,755,994 slots ~= 323 B; the Mojang proguard index
 * lands at 330 B). Rounded up so the derived budget errs toward stopping early.
 */
export const HEAP_BYTES_PER_INDEX_ENTRY = 340;

/** Share of the heap still free at load time that a single tiny load may claim. */
const HEAP_BUDGET_FRACTION = 0.7;

const MIN_INDEX_ENTRY_BUDGET = 1_000_000;
const MAX_INDEX_ENTRY_BUDGET = 64_000_000;

/**
 * How many index slots one Loom tiny load may accumulate before it stops and
 * warns instead of exhausting the heap.
 *
 * The default is derived from the live V8 heap limit, so raising
 * `--max-old-space-size` raises the budget automatically. `MCP_LOOM_TINY_MAX_INDEX_ENTRIES`
 * overrides it outright.
 */
export function resolveTinyIndexEntryBudget(
  value = process.env.MCP_LOOM_TINY_MAX_INDEX_ENTRIES,
  heapStats: { heap_size_limit: number; used_heap_size: number } = v8.getHeapStatistics()
): number {
  // Strict ASCII digits and safe integers only, mirroring `loadMaxFrameBytes` and
  // `loadMaxDownloadBytes`. Number.parseInt stops at the first non-digit, so "1e9",
  // "2_000_000", "10M" and "1.9" used to be accepted as 1, 2, 10 and 1 — a budget
  // that truncates every real Loom load. No floor is applied: an explicit override
  // is allowed to be small on purpose.
  if (/^[0-9]+$/.test(value ?? "")) {
    const override = Number(value);
    if (Number.isSafeInteger(override) && override > 0) {
      return override;
    }
  }
  const free = Math.max(0, heapStats.heap_size_limit - heapStats.used_heap_size);
  const derived = Math.floor((free * HEAP_BUDGET_FRACTION) / HEAP_BYTES_PER_INDEX_ENTRY);
  return Math.min(MAX_INDEX_ENTRY_BUDGET, Math.max(MIN_INDEX_ENTRY_BUDGET, derived));
}

export type TinyFileCandidate = {
  path: string;
  bytes: number;
  /**
   * Normalized first namespace column: the coordinates every descriptor in the file
   * uses. `official` and `obfuscated` normalize to the same value.
   */
  descriptorNamespace: SourceMapping | string;
  namespaces: SourceMapping[];
};

export type TinySelection = {
  /** Files to merge, in the order they should be merged. */
  selected: TinyFileCandidate[];
  /** Files whose bytes duplicate an already-selected file exactly. */
  duplicateOf: Map<string, string>;
  /**
   * Files skipped because they restate namespace pairs already covered by a
   * selected file while declaring their descriptors in a different namespace.
   */
  descriptorConflicts: TinyFileCandidate[];
  /** Files whose header is not a usable tiny v2 header. */
  unsupported: string[];
};

/**
 * Read just the first line of a tiny file and derive its namespace layout.
 * Returns `undefined` for anything {@link parseTinyHeader} rejects, so the body
 * of an unusable file is never read.
 */
export async function readTinyFileCandidate(path: string): Promise<TinyFileCandidate | undefined> {
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) {
      return undefined;
    }
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(Math.min(HEADER_PROBE_BYTES, info.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.search(/\r?\n/);
    // A file whose first line does not fit the probe cannot be a tiny header.
    const headerLine = newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : bytesRead < HEADER_PROBE_BYTES ? chunk : "";
    const header = parseTinyHeader(headerLine);
    if (!header) {
      return undefined;
    }
    return {
      path,
      bytes: info.size,
      descriptorNamespace: header.descriptorNamespace,
      namespaces: header.namespaces
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

/** Every ordered namespace pair a candidate's rows would populate. */
export function candidatePairKeys(candidate: TinyFileCandidate): PairKey[] {
  const keys: PairKey[] = [];
  for (const from of candidate.namespaces) {
    for (const to of candidate.namespaces) {
      if (from !== to) {
        keys.push(pairKey(from, to));
      }
    }
  }
  return keys;
}

/**
 * Richest first: more namespaces beats fewer; then a file whose descriptors are
 * written in obfuscated coordinates beats one that is not, because that is the
 * form callers query with and the form every other tiny source this server reads
 * (Fabric intermediary and yarn artifacts, the Maven loader) produces; then larger
 * beats smaller; then path order so the result never depends on filesystem
 * enumeration order.
 *
 * The descriptor-coordinate rule also decides which rendering becomes the one the
 * descriptor-conflict filter measures the rest against, so it must come before size:
 * Loom's `mappings-base.tiny` is written with `intermediary` first AND is the larger
 * file, and letting it win would leave the whole index carrying intermediary-coordinate
 * descriptors.
 */
export function compareCandidates(left: TinyFileCandidate, right: TinyFileCandidate): number {
  if (left.namespaces.length !== right.namespaces.length) {
    return right.namespaces.length - left.namespaces.length;
  }
  const leftCanonical = left.descriptorNamespace === "obfuscated" ? 1 : 0;
  const rightCanonical = right.descriptorNamespace === "obfuscated" ? 1 : 0;
  if (leftCanonical !== rightCanonical) {
    return rightCanonical - leftCanonical;
  }
  if (left.bytes !== right.bytes) {
    return right.bytes - left.bytes;
  }
  return left.path.localeCompare(right.path);
}

/**
 * Decide which of the discovered tiny files to merge.
 *
 * Loom keeps several renderings of one layered mapping set side by side in one
 * output directory: the final `mappings.tiny`, a `-mojang` rendering with an extra
 * column, `-migrated` renderings per loader build, and a `mappings-base.tiny`
 * written with the namespace columns rotated. Two filters apply:
 *
 * 1. Byte-identical files are collapsed. Loom copies the same rendering into every
 *    layered variant directory, so re-reading them is pure repeated work.
 * 2. A file is dropped as an alternative rendering when ALL of the following hold:
 *    it declares its descriptors in a different namespace than the rendering
 *    already chosen, it sits in a directory that already yielded a selected file,
 *    and every namespace pair it carries is already covered. Tiny v2 writes each
 *    descriptor once, in the file's first namespace; merging an `intermediary`-first
 *    rendering into an `official`-first index registers every method a second time
 *    under an incompatible descriptor, which turns unique lookups into ambiguous
 *    ones. All three conditions are required so that a genuinely different mapping
 *    file — a standalone yarn tiny, a cache in another Gradle root — is never
 *    mistaken for a rendering of data already loaded.
 */
export async function selectTinyFiles(paths: string[]): Promise<TinySelection> {
  const candidates: TinyFileCandidate[] = [];
  const unsupported: string[] = [];
  for (const path of paths) {
    const candidate = await readTinyFileCandidate(path);
    if (candidate) {
      candidates.push(candidate);
    } else {
      unsupported.push(path);
    }
  }
  candidates.sort(compareCandidates);

  // Only equal-sized files can be byte-identical, so hash nothing unless a size
  // actually collides.
  const sizeCounts = new Map<number, number>();
  for (const candidate of candidates) {
    sizeCounts.set(candidate.bytes, (sizeCounts.get(candidate.bytes) ?? 0) + 1);
  }
  const hashes = new Map<string, string>();
  const directoriesByHash = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if ((sizeCounts.get(candidate.bytes) ?? 0) < 2) {
      continue;
    }
    const digest = await hashFile(candidate.path);
    if (!digest) {
      continue;
    }
    const hash = `${candidate.bytes}:${digest}`;
    hashes.set(candidate.path, hash);
    const directories = directoriesByHash.get(hash) ?? new Set<string>();
    directories.add(dirname(candidate.path));
    directoriesByHash.set(hash, directories);
  }

  const selected: TinyFileCandidate[] = [];
  const descriptorConflicts: TinyFileCandidate[] = [];
  const duplicateOf = new Map<string, string>();
  const seenHashes = new Map<string, string>();
  const coveredPairs = new Set<PairKey>();
  // Directories a selected rendering was read from, including the directories its
  // byte-identical copies live in: any of them may hold sibling renderings.
  const renderedDirectories = new Set<string>();
  let descriptorNamespace: SourceMapping | string | undefined;

  for (const candidate of candidates) {
    const hash = hashes.get(candidate.path);
    if (hash) {
      const previous = seenHashes.get(hash);
      if (previous) {
        duplicateOf.set(candidate.path, previous);
        continue;
      }
      seenHashes.set(hash, candidate.path);
    }

    const pairs = candidatePairKeys(candidate);
    if (
      descriptorNamespace != null &&
      candidate.descriptorNamespace !== descriptorNamespace &&
      renderedDirectories.has(dirname(candidate.path)) &&
      pairs.every((key) => coveredPairs.has(key))
    ) {
      descriptorConflicts.push(candidate);
      continue;
    }

    descriptorNamespace ??= candidate.descriptorNamespace;
    for (const key of pairs) {
      coveredPairs.add(key);
    }
    renderedDirectories.add(dirname(candidate.path));
    if (hash) {
      for (const directory of directoriesByHash.get(hash) ?? []) {
        renderedDirectories.add(directory);
      }
    }
    selected.push(candidate);
  }

  return { selected, duplicateOf, descriptorConflicts, unsupported };
}
