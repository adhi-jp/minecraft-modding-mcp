/**
 * Tiny v2 mapping format parser. Pure; extracted from
 * `src/mapping-service.ts`.
 */

import type { SourceMapping } from "../../types.js";
import type {
  DirectionIndex,
  MappingSymbolRecord,
  PairKey
} from "../internal-types.js";
import {
  addLookupEntries,
  createClassSymbolRecord,
  createFieldSymbolRecord,
  createMethodSymbolRecord
} from "./symbol-records.js";
import { ensurePairIndex } from "./normalize.js";

export function normalizeTinyNamespace(namespace: string): SourceMapping | undefined {
  const normalized = namespace.trim().toLowerCase();
  if (normalized === "obfuscated" || normalized === "official") {
    return "obfuscated";
  }
  if (normalized === "mojang") {
    return "mojang";
  }
  if (normalized === "intermediary") {
    return "intermediary";
  }
  if (normalized === "named" || normalized === "yarn") {
    return "yarn";
  }
  return undefined;
}

/**
 * Namespace layout of a tiny v2 file, derivable from the header line alone.
 *
 * `descriptorNamespace` identifies the FIRST namespace column, normalized when this
 * server recognizes it (so `official` and `obfuscated` compare equal) and otherwise
 * the raw lower-cased token. Tiny v2 stores every field/method descriptor in that
 * namespace's coordinates and never repeats it per namespace, so two files whose
 * first column differs describe the same members with mutually incompatible
 * descriptors. Callers that merge several files into one index must compare this
 * value — see `src/mapping/loaders/tiny-loom-selection.ts`.
 */
export type TinyHeader = {
  descriptorNamespace: SourceMapping | string;
  /** Recognized namespaces paired with their data-column offset, in file order. */
  columns: Array<{ mapping: SourceMapping; columnIndex: number }>;
  /** Distinct recognized namespaces, in file order. */
  namespaces: SourceMapping[];
};

/**
 * Parse only the header line of a tiny v2 file. Returns `undefined` when the line
 * is not a tiny v2 header or declares fewer than two namespaces this server knows,
 * which is exactly when {@link parseTinyMappingsInto} would contribute nothing.
 * Lets callers classify a file without reading its body.
 */
export function parseTinyHeader(headerLine: string): TinyHeader | undefined {
  const header = headerLine.split("\t");
  if (header.length < 5 || header[0] !== "tiny" || header[1] !== "2") {
    return undefined;
  }

  const columns = header
    .slice(3)
    .map((namespace, index) => ({
      mapping: normalizeTinyNamespace(namespace),
      columnIndex: index + 1
    }))
    .filter(
      (entry): entry is { mapping: SourceMapping; columnIndex: number } => entry.mapping != null
    );
  if (columns.length < 2) {
    return undefined;
  }

  const namespaces: SourceMapping[] = [];
  for (const column of columns) {
    if (!namespaces.includes(column.mapping)) {
      namespaces.push(column.mapping);
    }
  }

  const rawDescriptorNamespace = header[3]!.trim().toLowerCase();
  return {
    descriptorNamespace: normalizeTinyNamespace(rawDescriptorNamespace) ?? rawDescriptorNamespace,
    columns,
    namespaces
  };
}

export function addPairRecords(
  target: Map<PairKey, DirectionIndex>,
  records: Map<SourceMapping, MappingSymbolRecord>
): void {
  for (const [sourceMapping, sourceRecord] of records.entries()) {
    for (const [targetMapping, targetRecord] of records.entries()) {
      if (sourceMapping === targetMapping) {
        continue;
      }
      addLookupEntries(ensurePairIndex(target, sourceMapping, targetMapping), sourceRecord, targetRecord);
    }
  }
}

/** Total number of index slots held by a pair map; the unit the parse budget counts. */
export function countIndexEntries(pairs: Map<PairKey, DirectionIndex>): number {
  let total = 0;
  for (const index of pairs.values()) {
    total += index.exact.size + index.normalized.size + index.simple.size + index.records.size;
  }
  return total;
}

export type TinyParseOptions = {
  /**
   * Stop parsing once the target holds this many index slots (see
   * {@link countIndexEntries}). Guards a single unbounded accumulator against
   * caches large enough to exhaust the V8 heap. Omit for no bound.
   */
  maxIndexEntries?: number;
};

export type TinyParseResult = {
  /** False when the header was not usable, so nothing was added. */
  parsed: boolean;
  /** True when `maxIndexEntries` stopped the parse before the last line. */
  truncated: boolean;
  /** Index slots held by the target after this parse. */
  indexEntries: number;
};

/** How often the running index size is re-measured while parsing. */
const BUDGET_CHECK_INTERVAL = 512;

/**
 * Parse `text` directly into `target`.
 *
 * Writing into the caller's accumulator rather than into a private map and
 * merging afterwards is what keeps multi-file loads inside the heap: a
 * parse-then-merge loop holds the whole per-file index AND the accumulated index
 * at the same time, roughly doubling peak usage on the largest file. Merging is
 * not lost — `ensurePairIndex` + `addLookupEntries` union into whatever is
 * already present, which is precisely what `mergeDirectionIndexes` did.
 */
export function parseTinyMappingsInto(
  target: Map<PairKey, DirectionIndex>,
  text: string,
  options?: TinyParseOptions
): TinyParseResult {
  const budget = options?.maxIndexEntries;
  const lines = text.split(/\r?\n/);
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim().length > 0) {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    return { parsed: false, truncated: false, indexEntries: countIndexEntries(target) };
  }

  const header = parseTinyHeader(lines[headerIndex]!);
  if (!header) {
    return { parsed: false, truncated: false, indexEntries: countIndexEntries(target) };
  }

  let entries = countIndexEntries(target);
  if (budget != null && entries >= budget) {
    return { parsed: true, truncated: true, indexEntries: entries };
  }

  const currentClassNames = new Map<SourceMapping, string>();
  let sinceBudgetCheck = 0;

  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.trim().length === 0) {
      continue;
    }

    if (budget != null) {
      sinceBudgetCheck += 1;
      if (sinceBudgetCheck >= BUDGET_CHECK_INTERVAL) {
        sinceBudgetCheck = 0;
        entries = countIndexEntries(target);
        if (entries >= budget) {
          return { parsed: true, truncated: true, indexEntries: entries };
        }
      }
    }

    const columns = line.split("\t");
    if (columns[0] === "c") {
      const classRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of header.columns) {
        const value = columns[namespace.columnIndex]?.trim() ?? "";
        if (!value) {
          // A class row that omits this namespace ends the previous class's name
          // for it. Leaving the stale entry made the following field/method rows
          // register under the PREVIOUS class as owner, at confidence 1.
          currentClassNames.delete(namespace.mapping);
          continue;
        }
        currentClassNames.set(namespace.mapping, value);
        classRecords.set(namespace.mapping, createClassSymbolRecord(value));
      }
      addPairRecords(target, classRecords);
      continue;
    }

    if (columns[0] === "" && columns[1] === "f") {
      const fieldRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of header.columns) {
        const owner = currentClassNames.get(namespace.mapping);
        const value = columns[namespace.columnIndex + 2]?.trim() ?? "";
        if (!owner || !value) {
          continue;
        }
        fieldRecords.set(namespace.mapping, createFieldSymbolRecord(owner, value));
      }
      addPairRecords(target, fieldRecords);
      continue;
    }

    if (columns[0] === "" && columns[1] === "m") {
      const descriptor = columns[2]?.trim() || undefined;
      const methodRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of header.columns) {
        const owner = currentClassNames.get(namespace.mapping);
        const value = columns[namespace.columnIndex + 2]?.trim() ?? "";
        if (!owner || !value) {
          continue;
        }
        methodRecords.set(namespace.mapping, createMethodSymbolRecord(owner, value, descriptor));
      }
      addPairRecords(target, methodRecords);
    }
  }

  return { parsed: true, truncated: false, indexEntries: countIndexEntries(target) };
}

export function parseTinyMappings(text: string): Map<PairKey, DirectionIndex> {
  const result = new Map<PairKey, DirectionIndex>();
  parseTinyMappingsInto(result, text);
  return result;
}
