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

export function parseTinyMappings(text: string): Map<PairKey, DirectionIndex> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return new Map();
  }

  const header = lines[0]!.split("\t");
  if (header.length < 5 || header[0] !== "tiny" || header[1] !== "2") {
    return new Map();
  }

  const namespaceColumns = header.slice(3).map((namespace, index) => ({
    mapping: normalizeTinyNamespace(namespace),
    columnIndex: index + 1
  }));
  const recognized = namespaceColumns.filter(
    (entry): entry is { mapping: SourceMapping; columnIndex: number } => entry.mapping != null
  );
  if (recognized.length < 2) {
    return new Map();
  }

  const result = new Map<PairKey, DirectionIndex>();
  const currentClassNames = new Map<SourceMapping, string>();
  for (const line of lines.slice(1)) {
    const columns = line.split("\t");
    if (columns[0] === "c") {
      const classRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of recognized) {
        const value = columns[namespace.columnIndex]?.trim() ?? "";
        if (!value) {
          continue;
        }
        currentClassNames.set(namespace.mapping, value);
        classRecords.set(namespace.mapping, createClassSymbolRecord(value));
      }
      addPairRecords(result, classRecords);
      continue;
    }

    if (columns[0] === "" && columns[1] === "f") {
      const fieldRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of recognized) {
        const owner = currentClassNames.get(namespace.mapping);
        const value = columns[namespace.columnIndex + 2]?.trim() ?? "";
        if (!owner || !value) {
          continue;
        }
        fieldRecords.set(namespace.mapping, createFieldSymbolRecord(owner, value));
      }
      addPairRecords(result, fieldRecords);
      continue;
    }

    if (columns[0] === "" && columns[1] === "m") {
      const descriptor = columns[2]?.trim() || undefined;
      const methodRecords = new Map<SourceMapping, MappingSymbolRecord>();
      for (const namespace of recognized) {
        const owner = currentClassNames.get(namespace.mapping);
        const value = columns[namespace.columnIndex + 2]?.trim() ?? "";
        if (!owner || !value) {
          continue;
        }
        methodRecords.set(namespace.mapping, createMethodSymbolRecord(owner, value, descriptor));
      }
      addPairRecords(result, methodRecords);
    }
  }

  return result;
}
