import type { SourceMapping } from "../../types.js";
import type {
  DirectionIndex,
  MappingSymbolRecord,
  PairKey,
  PairRecord
} from "../internal-types.js";
import { buildSymbolKey, createDirectionIndex } from "./symbol-records.js";

export function pairKey(sourceMapping: SourceMapping, targetMapping: SourceMapping): PairKey {
  return `${sourceMapping}->${targetMapping}`;
}

export function parsePairKey(key: PairKey): { sourceMapping: SourceMapping; targetMapping: SourceMapping } {
  const separator = key.indexOf("->");
  const source = separator >= 0 ? key.slice(0, separator) : key;
  const target = separator >= 0 ? key.slice(separator + 2) : "";
  return {
    sourceMapping: source as SourceMapping,
    targetMapping: target as SourceMapping
  };
}

export function buildAdjacency(
  pairs: Map<PairKey, PairRecord>
): Map<SourceMapping, SourceMapping[]> {
  const adjacency = new Map<SourceMapping, Set<SourceMapping>>();
  for (const key of pairs.keys()) {
    const { sourceMapping, targetMapping } = parsePairKey(key);
    let neighbors = adjacency.get(sourceMapping);
    if (!neighbors) {
      neighbors = new Set<SourceMapping>();
      adjacency.set(sourceMapping, neighbors);
    }
    neighbors.add(targetMapping);
  }

  return new Map(
    [...adjacency.entries()].map(([mapping, neighbors]) => [mapping, [...neighbors]])
  );
}

export function buildTargetRecordIndex(
  pairs: Map<PairKey, PairRecord>
): Map<SourceMapping, MappingSymbolRecord[]> {
  const recordsByTarget = new Map<SourceMapping, Map<string, MappingSymbolRecord>>();
  for (const [key, pair] of pairs.entries()) {
    const { targetMapping } = parsePairKey(key);
    let bucket = recordsByTarget.get(targetMapping);
    if (!bucket) {
      bucket = new Map<string, MappingSymbolRecord>();
      recordsByTarget.set(targetMapping, bucket);
    }
    for (const record of pair.index.records.values()) {
      bucket.set(buildSymbolKey(record), record);
    }
  }

  return new Map(
    [...recordsByTarget.entries()].map(([mapping, records]) => [mapping, [...records.values()]])
  );
}

export function ensurePairIndex(
  indexes: Map<PairKey, DirectionIndex>,
  from: SourceMapping,
  to: SourceMapping
): DirectionIndex {
  const key = pairKey(from, to);
  const existing = indexes.get(key);
  if (existing) {
    return existing;
  }
  const created = createDirectionIndex();
  indexes.set(key, created);
  return created;
}
