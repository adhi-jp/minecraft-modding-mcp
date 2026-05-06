/**
 * Symbol-record helpers and DirectionIndex builders used by every mapping
 * parser. Pure functions; behavior-preserving extraction from
 * `src/mapping-service.ts`.
 */

import type {
  DirectionIndex,
  MappingSymbolRecord
} from "../internal-types.js";

export function createDirectionIndex(): DirectionIndex {
  return {
    exact: new Map<string, Set<string>>(),
    normalized: new Map<string, Set<string>>(),
    simple: new Map<string, Set<string>>(),
    records: new Map<string, MappingSymbolRecord>()
  };
}

export function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return;
  }

  const existing = map.get(normalizedKey) ?? new Set<string>();
  existing.add(value);
  map.set(normalizedKey, existing);
}

export function normalizedVariants(symbol: string): string[] {
  const variants = [symbol];
  let dotted: string | undefined;
  if (symbol.includes("/")) {
    dotted = symbol.replace(/\//g, ".");
    if (dotted !== symbol) {
      variants.push(dotted);
    }
  }

  if (symbol.includes(".")) {
    const slashed = symbol.replace(/\./g, "/");
    if (slashed !== symbol && slashed !== dotted) {
      variants.push(slashed);
    }
  }

  return variants;
}

export function simpleName(symbol: string): string | undefined {
  const trimmed = symbol.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutDescriptor = trimmed.includes("(") ? trimmed.slice(0, trimmed.indexOf("(")) : trimmed;
  const base = withoutDescriptor.split(/[./]/).at(-1)?.trim();
  return base || undefined;
}

export function normalizeMappedSymbolOutput(symbol: string): string {
  return symbol.replace(/\//g, ".");
}

export function splitOwnerAndName(symbol: string): { owner: string; name: string } | undefined {
  const trimmed = symbol.trim();
  const separatorIndex = Math.max(trimmed.lastIndexOf("."), trimmed.lastIndexOf("/"));
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return {
    owner: trimmed.slice(0, separatorIndex),
    name: trimmed.slice(separatorIndex + 1)
  };
}

export function stripLineInfo(input: string): string {
  let value = input.trim();
  while (/^\d+:\d+:/.test(value)) {
    value = value.replace(/^\d+:\d+:/, "");
  }
  return value.replace(/:\d+:\d+$/, "").trim();
}

export function parseMethodName(value: string): string | undefined {
  const match = /^(.+?)\s+([^\s(]+)\((.*)\)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() || undefined;
}

export function parseFieldName(value: string): string | undefined {
  const match = /^(.+?)\s+([^\s]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() || undefined;
}

export function buildSymbolKey(record: MappingSymbolRecord): string {
  return `${record.kind}|${record.owner ?? ""}|${record.name}|${record.descriptor ?? ""}`;
}

export function classNameParts(classFqn: string): { owner?: string; name: string } {
  const separatorIndex = classFqn.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= classFqn.length - 1) {
    return {
      owner: undefined,
      name: classFqn
    };
  }
  return {
    owner: classFqn.slice(0, separatorIndex),
    name: classFqn.slice(separatorIndex + 1)
  };
}

export function createClassSymbolRecord(className: string): MappingSymbolRecord {
  const symbol = normalizeMappedSymbolOutput(className.trim());
  const parts = classNameParts(symbol);
  return {
    kind: "class",
    symbol,
    owner: parts.owner,
    name: parts.name
  };
}

export function createFieldSymbolRecord(owner: string, fieldName: string): MappingSymbolRecord {
  const normalizedOwner = normalizeMappedSymbolOutput(owner.trim());
  const normalizedName = fieldName.trim();
  return {
    kind: "field",
    symbol: `${normalizedOwner}.${normalizedName}`,
    owner: normalizedOwner,
    name: normalizedName
  };
}

export function createMethodSymbolRecord(
  owner: string,
  methodName: string,
  descriptor: string | undefined
): MappingSymbolRecord {
  const normalizedOwner = normalizeMappedSymbolOutput(owner.trim());
  const normalizedName = methodName.trim();
  const normalizedDescriptor = descriptor?.trim() || undefined;
  return {
    kind: "method",
    symbol: `${normalizedOwner}.${normalizedName}${normalizedDescriptor ?? ""}`,
    owner: normalizedOwner,
    name: normalizedName,
    descriptor: normalizedDescriptor
  };
}

export function parseInputSymbol(symbol: string): MappingSymbolRecord | undefined {
  const trimmed = symbol.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return undefined;
  }

  const openIndex = trimmed.indexOf("(");
  if (openIndex >= 0) {
    const closeIndex = trimmed.indexOf(")", openIndex);
    if (closeIndex < 0) {
      return undefined;
    }
    const ownerAndMethod = splitOwnerAndName(trimmed.slice(0, openIndex));
    if (!ownerAndMethod) {
      return undefined;
    }
    const descriptor = trimmed.slice(openIndex);
    return createMethodSymbolRecord(ownerAndMethod.owner, ownerAndMethod.name, descriptor);
  }

  const ownerAndName = splitOwnerAndName(trimmed);
  if (!ownerAndName) {
    return createClassSymbolRecord(trimmed);
  }

  if (/^[A-Z$]/.test(ownerAndName.name)) {
    return createClassSymbolRecord(trimmed);
  }
  return createFieldSymbolRecord(ownerAndName.owner, ownerAndName.name);
}

export function exactLookupKeys(record: MappingSymbolRecord): string[] {
  const keys = new Set<string>([record.symbol]);
  if (record.kind === "method" && record.owner && record.descriptor) {
    keys.add(`${record.owner}.${record.name}`);
  }
  return [...keys];
}

export function simpleLookupKeys(record: MappingSymbolRecord): string[] {
  if (record.kind === "class") {
    return [record.name];
  }
  if (record.kind === "field") {
    return [record.name];
  }
  if (record.descriptor) {
    return [record.name, `${record.name}${record.descriptor}`];
  }
  return [record.name];
}

export function registerRecord(index: DirectionIndex, record: MappingSymbolRecord): string {
  const key = buildSymbolKey(record);
  if (!index.records.has(key)) {
    index.records.set(key, record);
  }
  return key;
}

export function addLookupEntries(index: DirectionIndex, fromRecord: MappingSymbolRecord, toRecord: MappingSymbolRecord): void {
  if (!fromRecord.symbol || !toRecord.symbol) {
    return;
  }

  const targetKey = registerRecord(index, toRecord);
  for (const key of exactLookupKeys(fromRecord)) {
    addToSetMap(index.exact, key, targetKey);
    for (const variant of normalizedVariants(key)) {
      if (variant !== key) {
        addToSetMap(index.normalized, variant, targetKey);
      }
    }
  }

  for (const key of simpleLookupKeys(fromRecord)) {
    addToSetMap(index.simple, key, targetKey);
  }
}

export function mergeDirectionIndexes(target: DirectionIndex, source: DirectionIndex): void {
  const mergeMap = (targetMap: Map<string, Set<string>>, sourceMap: Map<string, Set<string>>): void => {
    for (const [key, values] of sourceMap.entries()) {
      const existing = targetMap.get(key) ?? new Set<string>();
      for (const value of values) {
        existing.add(value);
      }
      targetMap.set(key, existing);
    }
  };

  mergeMap(target.exact, source.exact);
  mergeMap(target.normalized, source.normalized);
  mergeMap(target.simple, source.simple);
  for (const [key, value] of source.records.entries()) {
    if (!target.records.has(key)) {
      target.records.set(key, value);
    }
  }
}
