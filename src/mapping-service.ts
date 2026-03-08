import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES } from "./errors.js";
import { defaultDownloadPath, downloadToCache } from "./repo-downloader.js";
import { listJarEntries, readJarEntryAsUtf8 } from "./source-jar-reader.js";
import type { Config, MappingSourcePriority, SourceMapping } from "./types.js";
import { VersionService, isUnobfuscatedVersion, type ResolvedVersionMappings } from "./version-service.js";

const SUPPORTED_MAPPINGS: ReadonlySet<SourceMapping> = new Set([
  "obfuscated",
  "mojang",
  "intermediary",
  "yarn"
]);

const MATCH_RANK = {
  exact: 3,
  normalized: 2,
  "simple-name": 1
} as const;
const DESCRIPTOR_FALLBACK_CONFIDENCE = 0.85;
const MAX_CANDIDATES = 200;

type MatchRankKey = keyof typeof MATCH_RANK;
type PairKey = `${SourceMapping}->${SourceMapping}`;
type MappingLookupSource = "loom-cache" | "maven" | "mojang-client-mappings";
type MappingSymbolKind = "class" | "field" | "method";

type MappingSymbolRecord = {
  kind: MappingSymbolKind;
  symbol: string;
  owner?: string;
  name: string;
  descriptor?: string;
};

type DirectionIndex = {
  exact: Map<string, Set<string>>;
  normalized: Map<string, Set<string>>;
  simple: Map<string, Set<string>>;
  records: Map<string, MappingSymbolRecord>;
};

type PairRecord = {
  index: DirectionIndex;
  source: MappingLookupSource;
  mappingArtifact: string;
};

type VersionMappingsResolver = Pick<VersionService, "resolveVersionMappings">;

type CandidateAccumulator = {
  key: string;
  record: MappingSymbolRecord;
  matchKind: MappingMatchKind;
  confidence: number;
  rank: number;
};

type LoadedGraph = {
  version: string;
  priority: MappingSourcePriority;
  pairs: Map<PairKey, PairRecord>;
  adjacency: Map<SourceMapping, SourceMapping[]>;
  pathCache: Map<PairKey, SourceMapping[] | undefined>;
  recordsByTarget: Map<SourceMapping, MappingSymbolRecord[]>;
  warnings: string[];
};

export type MappingMatchKind = "exact" | "normalized" | "simple-name";

export type MappingLookupCandidate = {
  symbol: string;
  matchKind: MappingMatchKind;
  confidence: number;
  kind: MappingSymbolKind;
  owner?: string;
  name: string;
  descriptor?: string;
};

export type MappingLookupProvenance = {
  source: MappingLookupSource;
  mappingArtifact: string;
  version: string;
  priority: MappingSourcePriority;
};

export type SymbolQueryKind = MappingSymbolKind;

export type SymbolQueryInput = {
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
};

export type SymbolReference = {
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  symbol: string;
};

export type SymbolResolutionStatus = "resolved" | "not_found" | "ambiguous" | "mapping_unavailable";

export type SymbolResolutionOutput = {
  querySymbol: SymbolReference;
  mappingContext: {
    version: string;
    sourceMapping: SourceMapping;
    targetMapping?: SourceMapping;
    sourcePriorityApplied: MappingSourcePriority;
  };
  resolved: boolean;
  status: SymbolResolutionStatus;
  resolvedSymbol?: SymbolReference;
  candidates: Array<SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence">>;
  candidateCount: number;
  candidatesTruncated?: boolean;
  warnings: string[];
  provenance?: MappingLookupProvenance;
  ambiguityReasons?: string[];
};

export type FindMappingInput = {
  version: string;
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  signatureMode?: "exact" | "name-only";
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  disambiguation?: {
    ownerHint?: string;
    descriptorHint?: string;
  };
  maxCandidates?: number;
};

export type FindMappingOutput = SymbolResolutionOutput;

export type EnsureMappingAvailableInput = {
  version: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
};

export type EnsureMappingAvailableOutput = {
  transformChain: string[];
  warnings: string[];
  provenance?: MappingLookupProvenance;
};

export type ResolveMethodMappingExactInput = {
  version: string;
  name: string;
  owner: string;
  descriptor: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  maxCandidates?: number;
};

export type ResolveMethodMappingExactOutput = SymbolResolutionOutput;

export type ClassApiMatrixKind = "class" | "field" | "method";

export type ClassApiMatrixInput = {
  version: string;
  className: string;
  classNameMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  includeKinds?: ClassApiMatrixKind[];
  maxRows?: number;
};

export type ClassApiMatrixEntry = {
  symbol: string;
  owner?: string;
  name: string;
  descriptor?: string;
};

export type ClassApiMatrixRow = {
  kind: ClassApiMatrixKind;
  descriptor?: string;
  obfuscated?: ClassApiMatrixEntry;
  mojang?: ClassApiMatrixEntry;
  intermediary?: ClassApiMatrixEntry;
  yarn?: ClassApiMatrixEntry;
  completeness: boolean;
};

export type ClassApiMatrixOutput = {
  version: string;
  className: string;
  classNameMapping: SourceMapping;
  classIdentity: Partial<Record<SourceMapping, string>>;
  rows: ClassApiMatrixRow[];
  rowCount: number;
  rowsTruncated?: boolean;
  warnings: string[];
  ambiguousRowCount?: number;
};

export type SymbolExistenceInput = {
  version: string;
  kind: SymbolQueryKind;
  name: string;
  owner?: string;
  descriptor?: string;
  sourceMapping: SourceMapping;
  sourcePriority?: MappingSourcePriority;
  nameMode?: "fqcn" | "auto";
  signatureMode?: "exact" | "name-only";
  maxCandidates?: number;
};

export type SymbolExistenceOutput = SymbolResolutionOutput;

function createDirectionIndex(): DirectionIndex {
  return {
    exact: new Map<string, Set<string>>(),
    normalized: new Map<string, Set<string>>(),
    simple: new Map<string, Set<string>>(),
    records: new Map<string, MappingSymbolRecord>()
  };
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return;
  }

  const existing = map.get(normalizedKey) ?? new Set<string>();
  existing.add(value);
  map.set(normalizedKey, existing);
}

function normalizedVariants(symbol: string): string[] {
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

function simpleName(symbol: string): string | undefined {
  const trimmed = symbol.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutDescriptor = trimmed.includes("(") ? trimmed.slice(0, trimmed.indexOf("(")) : trimmed;
  const base = withoutDescriptor.split(/[./]/).at(-1)?.trim();
  return base || undefined;
}

function normalizeMappedSymbolOutput(symbol: string): string {
  return symbol.replace(/\//g, ".");
}

function splitOwnerAndName(symbol: string): { owner: string; name: string } | undefined {
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

function stripLineInfo(input: string): string {
  let value = input.trim();
  while (/^\d+:\d+:/.test(value)) {
    value = value.replace(/^\d+:\d+:/, "");
  }
  return value.replace(/:\d+:\d+$/, "").trim();
}

function parseMethodName(value: string): string | undefined {
  const match = /^(.+?)\s+([^\s(]+)\((.*)\)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() || undefined;
}

function parseFieldName(value: string): string | undefined {
  const match = /^(.+?)\s+([^\s]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() || undefined;
}

function buildSymbolKey(record: MappingSymbolRecord): string {
  return `${record.kind}|${record.owner ?? ""}|${record.name}|${record.descriptor ?? ""}`;
}

function classNameParts(classFqn: string): { owner?: string; name: string } {
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

function createClassSymbolRecord(className: string): MappingSymbolRecord {
  const symbol = normalizeMappedSymbolOutput(className.trim());
  const parts = classNameParts(symbol);
  return {
    kind: "class",
    symbol,
    owner: parts.owner,
    name: parts.name
  };
}

function createFieldSymbolRecord(owner: string, fieldName: string): MappingSymbolRecord {
  const normalizedOwner = normalizeMappedSymbolOutput(owner.trim());
  const normalizedName = fieldName.trim();
  return {
    kind: "field",
    symbol: `${normalizedOwner}.${normalizedName}`,
    owner: normalizedOwner,
    name: normalizedName
  };
}

function createMethodSymbolRecord(
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

function parseInputSymbol(symbol: string): MappingSymbolRecord | undefined {
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

function exactLookupKeys(record: MappingSymbolRecord): string[] {
  const keys = new Set<string>([record.symbol]);
  if (record.kind === "method" && record.owner && record.descriptor) {
    keys.add(`${record.owner}.${record.name}`);
  }
  return [...keys];
}

function simpleLookupKeys(record: MappingSymbolRecord): string[] {
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

function registerRecord(index: DirectionIndex, record: MappingSymbolRecord): string {
  const key = buildSymbolKey(record);
  if (!index.records.has(key)) {
    index.records.set(key, record);
  }
  return key;
}

function addLookupEntries(index: DirectionIndex, fromRecord: MappingSymbolRecord, toRecord: MappingSymbolRecord): void {
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

function mergeDirectionIndexes(target: DirectionIndex, source: DirectionIndex): void {
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

function pairKey(sourceMapping: SourceMapping, targetMapping: SourceMapping): PairKey {
  return `${sourceMapping}->${targetMapping}`;
}

function parsePairKey(key: PairKey): { sourceMapping: SourceMapping; targetMapping: SourceMapping } {
  const separator = key.indexOf("->");
  const source = separator >= 0 ? key.slice(0, separator) : key;
  const target = separator >= 0 ? key.slice(separator + 2) : "";
  return {
    sourceMapping: source as SourceMapping,
    targetMapping: target as SourceMapping
  };
}

function buildAdjacency(pairs: Map<PairKey, PairRecord>): Map<SourceMapping, SourceMapping[]> {
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

function buildTargetRecordIndex(
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

function ensurePairIndex(indexes: Map<PairKey, DirectionIndex>, from: SourceMapping, to: SourceMapping): DirectionIndex {
  const key = pairKey(from, to);
  const existing = indexes.get(key);
  if (existing) {
    return existing;
  }
  const created = createDirectionIndex();
  indexes.set(key, created);
  return created;
}

/** Map of proguard primitive type names to JVM type characters. */
const PROGUARD_PRIMITIVES: Record<string, string> = {
  void: "V", boolean: "Z", byte: "B", char: "C",
  short: "S", int: "I", long: "J", float: "F", double: "D"
};

/**
 * Convert a single proguard type (e.g. "int", "net.minecraft.Foo", "int[][]")
 * to JVM notation (e.g. "I", "Lnet/minecraft/Foo;", "[[I").
 * `classLookup` maps mojang class names → obfuscated class names (for the obfuscated descriptor).
 * Pass `undefined` to skip class name translation (for mojang descriptors).
 */
function proguardTypeToJvm(type: string, classLookup: Map<string, string> | undefined): string {
  let arrayDepth = 0;
  let base = type;
  while (base.endsWith("[]")) {
    arrayDepth += 1;
    base = base.slice(0, -2);
  }
  const prefix = "[".repeat(arrayDepth);
  const primitive = PROGUARD_PRIMITIVES[base];
  if (primitive) {
    return `${prefix}${primitive}`;
  }
  const translated = classLookup ? (classLookup.get(base) ?? base) : base;
  return `${prefix}L${translated.replace(/\./g, "/")};`;
}

/**
 * Parse a proguard method signature (after stripLineInfo) into a JVM descriptor.
 * Input format: "returnType methodName(paramType1,paramType2,...)"
 * Returns `{ name, descriptor }` or `undefined` if parsing fails.
 */
function parseProguardMethod(
  value: string,
  classLookup: Map<string, string> | undefined
): { name: string; descriptor: string } | undefined {
  const match = /^(.+?)\s+([^\s(]+)\((.*)\)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const returnType = match[1]!.trim();
  const name = match[2]!.trim();
  const params = match[3]!.trim();
  if (!name) {
    return undefined;
  }
  const paramParts = params ? params.split(",").map((p) => p.trim()) : [];
  const paramDescriptor = paramParts.map((p) => proguardTypeToJvm(p, classLookup)).join("");
  const returnDescriptor = proguardTypeToJvm(returnType, classLookup);
  return { name, descriptor: `(${paramDescriptor})${returnDescriptor}` };
}

function parseClientMappings(text: string): Map<PairKey, DirectionIndex> {
  const obfuscatedToMojang = createDirectionIndex();
  const mojangToObfuscated = createDirectionIndex();

  // Two-pass parsing: first collect class name mappings, then parse members with descriptors.
  const lines = text.split(/\r?\n/);

  // Pass 1: collect class name mappings (mojang → obfuscated)
  const mojangToObfuscatedClass = new Map<string, string>();
  let classCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const classMatch = /^(.+?)\s+->\s+(.+):$/.exec(line);
    if (classMatch) {
      const mojangClass = classMatch[1]?.trim() ?? "";
      const obfuscatedClass = classMatch[2]?.trim() ?? "";
      if (mojangClass && obfuscatedClass) {
        mojangToObfuscatedClass.set(mojangClass, obfuscatedClass);
        classCount += 1;
      }
    }
  }

  if (classCount === 0) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: "No class mappings could be parsed from client mappings."
    });
  }

  // Pass 2: build full index with descriptors
  let currentClass: { obfuscated: string; mojang: string } | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const classMatch = /^(.+?)\s+->\s+(.+):$/.exec(line);
    if (classMatch) {
      const mojangClass = classMatch[1]?.trim() ?? "";
      const obfuscatedClass = classMatch[2]?.trim() ?? "";
      if (!mojangClass || !obfuscatedClass) {
        currentClass = undefined;
        continue;
      }

      currentClass = {
        obfuscated: obfuscatedClass,
        mojang: mojangClass
      };

      addLookupEntries(
        obfuscatedToMojang,
        createClassSymbolRecord(obfuscatedClass),
        createClassSymbolRecord(mojangClass)
      );
      addLookupEntries(
        mojangToObfuscated,
        createClassSymbolRecord(mojangClass),
        createClassSymbolRecord(obfuscatedClass)
      );
      continue;
    }

    if (!currentClass) {
      continue;
    }

    const arrowIndex = line.indexOf(" -> ");
    if (arrowIndex < 0) {
      continue;
    }
    const leftRaw = line.slice(0, arrowIndex).trim();
    const rightRaw = line.slice(arrowIndex + 4).trim();
    if (!leftRaw || !rightRaw) {
      continue;
    }

    const mojangMemberSignature = stripLineInfo(leftRaw);

    // Try method parsing with JVM descriptor
    const obfuscatedMethod = parseProguardMethod(mojangMemberSignature, mojangToObfuscatedClass);
    if (obfuscatedMethod) {
      const mojangMethod = parseProguardMethod(mojangMemberSignature, undefined);
      const obfuscatedDescriptor = obfuscatedMethod.descriptor;
      const mojangDescriptor = mojangMethod?.descriptor;

      addLookupEntries(
        obfuscatedToMojang,
        createMethodSymbolRecord(currentClass.obfuscated, rightRaw, obfuscatedDescriptor),
        createMethodSymbolRecord(currentClass.mojang, obfuscatedMethod.name, mojangDescriptor)
      );
      addLookupEntries(
        mojangToObfuscated,
        createMethodSymbolRecord(currentClass.mojang, obfuscatedMethod.name, mojangDescriptor),
        createMethodSymbolRecord(currentClass.obfuscated, rightRaw, obfuscatedDescriptor)
      );
      continue;
    }

    const fieldName = parseFieldName(mojangMemberSignature);
    if (!fieldName) {
      continue;
    }
    addLookupEntries(
      obfuscatedToMojang,
      createFieldSymbolRecord(currentClass.obfuscated, rightRaw),
      createFieldSymbolRecord(currentClass.mojang, fieldName)
    );
    addLookupEntries(
      mojangToObfuscated,
      createFieldSymbolRecord(currentClass.mojang, fieldName),
      createFieldSymbolRecord(currentClass.obfuscated, rightRaw)
    );
  }

  const result = new Map<PairKey, DirectionIndex>();
  result.set(pairKey("obfuscated", "mojang"), obfuscatedToMojang);
  result.set(pairKey("mojang", "obfuscated"), mojangToObfuscated);
  return result;
}

function normalizeTinyNamespace(namespace: string): SourceMapping | undefined {
  const normalized = namespace.trim().toLowerCase();
  if (normalized === "obfuscated") {
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

function addPairRecords(
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

function parseTinyMappings(text: string): Map<PairKey, DirectionIndex> {
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

function addCandidates(
  target: Map<string, CandidateAccumulator>,
  index: DirectionIndex,
  symbols: Set<string> | undefined,
  kind: MatchRankKey,
  confidence: number
): void {
  if (!symbols || symbols.size === 0) {
    return;
  }

  const rank = MATCH_RANK[kind];
  for (const key of symbols) {
    const record = index.records.get(key);
    if (!record) {
      continue;
    }
    const current = target.get(key);
    if (!current || rank > current.rank || (rank === current.rank && confidence > current.confidence)) {
      target.set(key, {
        key,
        record,
        matchKind: kind,
        confidence,
        rank
      });
    }
  }
}

function lookupCandidates(index: DirectionIndex, query: MappingSymbolRecord): MappingLookupCandidate[] {
  const trimmedQuery = query.symbol.trim();
  const collected = new Map<string, CandidateAccumulator>();

  addCandidates(collected, index, index.exact.get(trimmedQuery), "exact", 1);

  for (const variant of normalizedVariants(trimmedQuery)) {
    addCandidates(collected, index, index.normalized.get(variant), "normalized", 0.9);
  }

  if (query.kind === "method" && query.owner && query.descriptor) {
    const descriptorlessKey = `${query.owner}.${query.name}`;
    addCandidates(
      collected,
      index,
      index.exact.get(descriptorlessKey),
      "normalized",
      DESCRIPTOR_FALLBACK_CONFIDENCE
    );
    for (const variant of normalizedVariants(descriptorlessKey)) {
      addCandidates(
        collected,
        index,
        index.normalized.get(variant),
        "normalized",
        DESCRIPTOR_FALLBACK_CONFIDENCE
      );
    }
  }

  const simpleKeys = new Set<string>();
  const shortName = simpleName(trimmedQuery);
  if (shortName) {
    simpleKeys.add(shortName);
  }
  if (query.kind !== "class") {
    simpleKeys.add(query.name);
  }
  if (query.kind === "method" && query.descriptor) {
    simpleKeys.add(`${query.name}${query.descriptor}`);
  }

  for (const key of simpleKeys) {
    addCandidates(collected, index, index.simple.get(key), "simple-name", 0.75);
  }

  return [...collected.values()]
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      if (right.rank !== left.rank) {
        return right.rank - left.rank;
      }
      return left.record.symbol.localeCompare(right.record.symbol);
    })
    .slice(0, MAX_CANDIDATES)
    .map(({ record, matchKind, confidence }) => ({
      symbol: record.symbol,
      matchKind,
      confidence,
      kind: record.kind,
      owner: record.owner,
      name: record.name,
      descriptor: record.descriptor
    }));
}

function mappingPriorityFromInput(
  configPriority: MappingSourcePriority,
  override: MappingSourcePriority | undefined
): MappingSourcePriority {
  if (override === "loom-first" || override === "maven-first") {
    return override;
  }
  return configPriority;
}

function mappingSourceOrder(priority: MappingSourcePriority): Array<"loom-cache" | "maven"> {
  if (priority === "maven-first") {
    return ["maven", "loom-cache"];
  }
  return ["loom-cache", "maven"];
}

function namespacePath(
  graph: LoadedGraph,
  sourceMapping: SourceMapping,
  targetMapping: SourceMapping
): SourceMapping[] | undefined {
  if (sourceMapping === targetMapping) {
    return [sourceMapping];
  }

  const key = pairKey(sourceMapping, targetMapping);
  if (graph.pathCache.has(key)) {
    return graph.pathCache.get(key);
  }

  const { adjacency } = graph;
  const queue: SourceMapping[] = [sourceMapping];
  let queueIndex = 0;
  const parent = new Map<SourceMapping, SourceMapping | undefined>([[sourceMapping, undefined]]);

  while (queueIndex < queue.length) {
    const current = queue[queueIndex] as SourceMapping;
    queueIndex += 1;
    if (current === targetMapping) {
      break;
    }

    const neighbors = adjacency.get(current);
    if (!neighbors) {
      continue;
    }
    for (const neighbor of neighbors) {
      if (parent.has(neighbor)) {
        continue;
      }
      parent.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  if (!parent.has(targetMapping)) {
    graph.pathCache.set(key, undefined);
    return undefined;
  }

  const reversedPath: SourceMapping[] = [];
  let cursor: SourceMapping | undefined = targetMapping;
  while (cursor) {
    reversedPath.push(cursor);
    cursor = parent.get(cursor);
  }
  const path = reversedPath.reverse();
  graph.pathCache.set(key, path);
  return path;
}

function pathUsesSource(
  pairs: Map<PairKey, PairRecord>,
  path: SourceMapping[],
  source: MappingLookupSource
): boolean {
  for (let index = 0; index < path.length - 1; index += 1) {
    const hop = pairs.get(pairKey(path[index], path[index + 1]));
    if (hop?.source === source) {
      return true;
    }
  }
  return false;
}

function pathToTransformChain(path: SourceMapping[]): string[] {
  if (path.length <= 1) {
    return [];
  }
  const transform: string[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    transform.push(`mapping:${path[index]}->${path[index + 1]}`);
  }
  return transform;
}

function toLookupCandidate(record: MappingSymbolRecord): MappingLookupCandidate {
  return {
    symbol: record.symbol,
    matchKind: "exact",
    confidence: 1,
    kind: record.kind,
    owner: record.owner,
    name: record.name,
    descriptor: record.descriptor
  };
}

function toSymbolReference(record: MappingSymbolRecord): SymbolReference {
  return {
    kind: record.kind,
    name: record.kind === "class" ? record.symbol : record.name,
    owner: record.kind === "class" ? undefined : record.owner,
    descriptor: record.kind === "method" ? record.descriptor : undefined,
    symbol: record.symbol
  };
}

function toResolutionCandidate(
  candidate: MappingLookupCandidate
): SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence"> {
  return {
    kind: candidate.kind,
    name: candidate.kind === "class" ? candidate.symbol : candidate.name,
    owner: candidate.kind === "class" ? undefined : candidate.owner,
    descriptor: candidate.kind === "method" ? candidate.descriptor : undefined,
    symbol: candidate.symbol,
    matchKind: candidate.matchKind,
    confidence: candidate.confidence
  };
}

function invalidInputError(message: string, details: Record<string, unknown>) {
  return createError({
    code: ERROR_CODES.INVALID_INPUT,
    message,
    details
  });
}

function normalizeMemberName(name: string): string {
  const normalized = name.trim();
  if (!normalized || /[\s./()]/.test(normalized)) {
    throw invalidInputError(
      "name must be a simple member name without separators when kind is field or method.",
      {
        name
      }
    );
  }
  return normalized;
}

function normalizeMethodDescriptor(descriptor: string | undefined): string {
  const normalized = descriptor?.trim() ?? "";
  if (!normalized || !normalized.startsWith("(") || !normalized.includes(")")) {
    throw invalidInputError("descriptor must be a valid JVM descriptor when kind=method.", {
      descriptor
    });
  }
  return normalized;
}

function normalizeQuerySymbol(
  input: SymbolQueryInput,
  signatureMode?: "exact" | "name-only"
): {
  record: MappingSymbolRecord;
  querySymbol: SymbolReference;
} {
  if (input.kind !== "class" && input.kind !== "field" && input.kind !== "method") {
    throw invalidInputError('kind must be one of "class", "field", or "method".', {
      kind: input.kind
    });
  }

  const normalizedName = input.name?.trim() ?? "";
  if (!normalizedName) {
    throw invalidInputError("name must be a non-empty string.", {
      name: input.name
    });
  }

  if (input.kind === "class") {
    const owner = input.owner?.trim();
    if (owner) {
      throw invalidInputError("owner is not allowed when kind=class. Use name as FQCN.", {
        owner: input.owner,
        nextAction: 'Provide class as name, e.g. "net.minecraft.server.Main".'
      });
    }
    if (input.descriptor?.trim()) {
      throw invalidInputError("descriptor is not allowed when kind=class.", {
        descriptor: input.descriptor
      });
    }

    const className = normalizeMappedSymbolOutput(normalizedName);
    if (!className.includes(".")) {
      throw invalidInputError("name must be a fully qualified class name when kind=class.", {
        name: input.name
      });
    }
    const record = createClassSymbolRecord(className);
    return {
      record,
      querySymbol: toSymbolReference(record)
    };
  }

  const owner = normalizeMappedSymbolOutput(input.owner?.trim() ?? "");
  if (!owner) {
    throw invalidInputError("owner is required when kind is field or method.", {
      owner: input.owner,
      kind: input.kind
    });
  }

  if (input.kind === "field") {
    if (input.descriptor?.trim()) {
      throw invalidInputError("descriptor is not allowed when kind=field.", {
        descriptor: input.descriptor
      });
    }
    const record = createFieldSymbolRecord(owner, normalizeMemberName(normalizedName));
    return {
      record,
      querySymbol: toSymbolReference(record)
    };
  }

  const descriptor = signatureMode === "name-only"
    ? (input.descriptor?.trim() || "")
    : normalizeMethodDescriptor(input.descriptor);
  const record = createMethodSymbolRecord(
    owner,
    normalizeMemberName(normalizedName),
    descriptor
  );
  return {
    record,
    querySymbol: toSymbolReference(record)
  };
}

function normalizeOwnerHint(ownerHint: string | undefined): string | undefined {
  const normalized = ownerHint?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalizeMappedSymbolOutput(normalized);
}

function normalizeDescriptorHint(descriptorHint: string | undefined): string | undefined {
  const normalized = descriptorHint?.trim();
  return normalized || undefined;
}

function applyDisambiguationHints(
  candidates: MappingLookupCandidate[],
  disambiguation: { ownerHint?: string; descriptorHint?: string } | undefined
): MappingLookupCandidate[] {
  if (!disambiguation || candidates.length <= 1) {
    return candidates;
  }

  let filtered = [...candidates];
  const ownerHint = normalizeOwnerHint(disambiguation.ownerHint);
  if (ownerHint) {
    const ownerMatched = filtered.filter((candidate) => {
      if (candidate.owner) {
        return normalizeMappedSymbolOutput(candidate.owner) === ownerHint;
      }
      const normalizedSymbol = normalizeMappedSymbolOutput(candidate.symbol);
      return normalizedSymbol.startsWith(`${ownerHint}.`);
    });
    if (ownerMatched.length > 0) {
      filtered = ownerMatched;
    }
  }

  const descriptorHint = normalizeDescriptorHint(disambiguation.descriptorHint);
  if (descriptorHint) {
    const descriptorMatched = filtered.filter((candidate) => candidate.descriptor === descriptorHint);
    if (descriptorMatched.length > 0) {
      filtered = descriptorMatched;
    }
  }

  return filtered;
}

function collectTargetRecords(graph: LoadedGraph, targetMapping: SourceMapping): MappingSymbolRecord[] {
  return [...(graph.recordsByTarget.get(targetMapping) ?? [])];
}

function normalizeIncludedKinds(inputKinds: ClassApiMatrixKind[] | undefined): Set<ClassApiMatrixKind> {
  const normalized = new Set<ClassApiMatrixKind>();
  const kinds = inputKinds ?? ["class", "field", "method"];
  for (const kind of kinds) {
    if (kind === "class" || kind === "field" || kind === "method") {
      normalized.add(kind);
    }
  }
  if (normalized.size === 0) {
    normalized.add("class");
    normalized.add("field");
    normalized.add("method");
  }
  return normalized;
}

type ResolutionCandidate = SymbolReference & Pick<MappingLookupCandidate, "matchKind" | "confidence">;

function inferAmbiguityReasons(
  candidates: ResolutionCandidate[],
  usedMojangClientMappings: boolean
): string[] {
  if (candidates.length <= 1) {
    return [];
  }
  const reasons: string[] = [];

  const owners = [...new Set(candidates.map((c) => c.owner).filter(Boolean))];
  if (owners.length > 1) {
    reasons.push(`Multiple owner classes matched: ${owners.join(", ")}`);
  }

  const matchKinds = [...new Set(candidates.map((c) => c.matchKind))];
  if (matchKinds.length > 1) {
    reasons.push(`Candidates matched at different precision levels: ${matchKinds.join(", ")}`);
  }

  if (usedMojangClientMappings) {
    const hasDescriptor = candidates.some((c) => c.descriptor);
    const missingDescriptor = candidates.some((c) => !c.descriptor);
    if (hasDescriptor && missingDescriptor) {
      reasons.push("Method descriptor was lost through mojang-client-mappings path, causing broader matching.");
    }
  }

  if (owners.length <= 1) {
    const descriptors = [...new Set(candidates.map((c) => c.descriptor).filter(Boolean))];
    if (descriptors.length > 1) {
      reasons.push(`Overloaded method: ${descriptors.length} variants`);
    }
  }

  if (reasons.length === 0) {
    reasons.push(`${candidates.length} candidates matched with similar confidence scores.`);
  }

  return reasons;
}

function clampCandidateLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit == null) {
    return MAX_CANDIDATES;
  }
  return Math.max(1, Math.min(MAX_CANDIDATES, Math.trunc(limit)));
}

function limitResolutionCandidates(
  candidates: ResolutionCandidate[],
  requestedLimit: number | undefined
): {
  candidates: ResolutionCandidate[];
  candidateCount: number;
  candidatesTruncated?: boolean;
} {
  const candidateCount = candidates.length;
  const limit = clampCandidateLimit(requestedLimit);
  const limitedCandidates = candidateCount > limit ? candidates.slice(0, limit) : candidates;
  return {
    candidates: limitedCandidates,
    candidateCount,
    ...(limitedCandidates.length < candidateCount ? { candidatesTruncated: true } : {})
  };
}

function clampRowLimit(limit: number | undefined): number | undefined {
  if (!Number.isFinite(limit) || limit == null) {
    return undefined;
  }
  return Math.max(1, Math.min(5000, Math.trunc(limit)));
}

export class MappingService {
  private readonly config: Config;
  private readonly versionService: VersionMappingsResolver;
  private readonly fetchFn: typeof fetch;
  private readonly graphCache = new Map<string, LoadedGraph>();
  private readonly buildLocks = new Map<string, Promise<LoadedGraph>>();

  constructor(
    config: Config,
    versionService: VersionMappingsResolver = new VersionService(config),
    fetchFn: typeof fetch = globalThis.fetch
  ) {
    this.config = config;
    this.versionService = versionService;
    this.fetchFn = fetchFn;
  }

  async findMapping(input: FindMappingInput): Promise<FindMappingOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }

    const { record: queryRecord, querySymbol } = normalizeQuerySymbol(input, input.signatureMode);

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair for lookup.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      targetMapping,
      sourcePriorityApplied: priority
    } satisfies FindMappingOutput["mappingContext"];

    if (sourceMapping === targetMapping) {
      const identity = toResolutionCandidate({
        ...toLookupCandidate(queryRecord),
        matchKind: "exact",
        confidence: 1
      });
      const limited = limitResolutionCandidates([identity], input.maxCandidates);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: querySymbol,
        candidates: limited.candidates,
        candidateCount: limited.candidateCount,
        candidatesTruncated: limited.candidatesTruncated,
        warnings: []
      };
    }

    const graph = await this.loadGraph(version, priority);
    const path = namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: [
          `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`
        ]
      };
    }

    const rawCandidates = this.mapCandidatesAlongPath(graph, path, queryRecord);
    const warnings: string[] = [];
    const disambiguatedCandidates = applyDisambiguationHints(rawCandidates, input.disambiguation);
    if (rawCandidates.length > disambiguatedCandidates.length) {
      warnings.push(
        `Disambiguation hints narrowed candidates from ${rawCandidates.length} to ${disambiguatedCandidates.length}.`
      );
    }
    const candidates = disambiguatedCandidates.map(toResolutionCandidate);
    const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);
    if (
      queryRecord.kind === "method" &&
      queryRecord.descriptor &&
      pathUsesSource(graph.pairs, path, "mojang-client-mappings") &&
      candidates.length !== 1
    ) {
      warnings.push(
        "Method descriptor could not be preserved through mojang-client-mappings and may have used name-based fallback."
      );
    }
    if (candidates.length === 0) {
      warnings.push("No mapping candidate matched the input symbol.");
    } else if (candidates.length > 1) {
      warnings.push(
        `Ambiguous mapping: ${candidates.length} candidates matched. Provide a stricter symbol input or disambiguation hints.`
      );
    }

    const status: SymbolResolutionStatus =
      candidates.length === 0 ? "not_found" : candidates.length === 1 ? "resolved" : "ambiguous";

    const ambiguityReasons =
      candidates.length > 1
        ? inferAmbiguityReasons(candidates, pathUsesSource(graph.pairs, path, "mojang-client-mappings"))
        : undefined;

    return {
      querySymbol,
      mappingContext,
      resolved: status === "resolved",
      status,
      resolvedSymbol: status === "resolved" ? candidates[0] : undefined,
      candidates: limitedCandidates.candidates,
      candidateCount: limitedCandidates.candidateCount,
      candidatesTruncated: limitedCandidates.candidatesTruncated,
      warnings,
      provenance: this.provenanceForPath(graph, path),
      ambiguityReasons
    };
  }

  async ensureMappingAvailable(input: EnsureMappingAvailableInput): Promise<EnsureMappingAvailableOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    if (sourceMapping === targetMapping) {
      return {
        transformChain: [`mapping:${sourceMapping}->${targetMapping}`],
        warnings: []
      };
    }

    const graph = await this.loadGraph(version, priority);
    const path = namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`,
        details: {
          version,
          sourceMapping,
          targetMapping,
          sourcePriority: priority,
          nextAction: "Try mapping=obfuscated which is always available.",
          suggestedCall: { tool: "resolve-artifact", params: { mapping: "obfuscated" } }
        }
      });
    }

    const provenance = this.provenanceForPath(graph, path);
    const transformChain = [
      provenance ? `mapping-source:${provenance.source}` : undefined,
      ...pathToTransformChain(path)
    ].filter((entry): entry is string => Boolean(entry));

    return {
      transformChain,
      warnings: [...graph.warnings],
      provenance
    };
  }

  async resolveMethodMappingExact(
    input: ResolveMethodMappingExactInput
  ): Promise<ResolveMethodMappingExactOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }
    const { record: queryRecord, querySymbol } = normalizeQuerySymbol({
      ...input,
      kind: "method"
    });
    const owner = queryRecord.owner as string;
    const method = queryRecord.name;
    const descriptor = queryRecord.descriptor as string;

    const sourceMapping = input.sourceMapping;
    const targetMapping = input.targetMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping) || !SUPPORTED_MAPPINGS.has(targetMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping pair for exact method resolution.",
        details: {
          version,
          sourceMapping,
          targetMapping
        }
      });
    }
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      targetMapping,
      sourcePriorityApplied: priority
    } satisfies ResolveMethodMappingExactOutput["mappingContext"];

    if (sourceMapping === targetMapping) {
      const resolvedCandidate = toResolutionCandidate({
        ...toLookupCandidate(queryRecord),
        matchKind: "exact",
        confidence: 1
      });
      const limited = limitResolutionCandidates([resolvedCandidate], input.maxCandidates);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: resolvedCandidate,
        candidates: limited.candidates,
        candidateCount: limited.candidateCount,
        candidatesTruncated: limited.candidatesTruncated,
        warnings: []
      };
    }

    const graph = await this.loadGraph(version, priority);
    const path = namespacePath(graph, sourceMapping, targetMapping);

    if (!path) {
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings: [
          `No mapping path is available for ${sourceMapping} -> ${targetMapping} on version "${version}".`
        ]
      };
    }

    const warnings: string[] = [];
    const rawCandidates = this
      .mapCandidatesAlongPath(graph, path, queryRecord)
      .filter((candidate) => candidate.kind === "method");
    const candidates = rawCandidates.map(toResolutionCandidate);
    const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);

    const strictCandidates = rawCandidates.filter((candidate) => candidate.descriptor === descriptor);
    if (strictCandidates.length === 1) {
      const resolved = toResolutionCandidate(strictCandidates[0]!);
      return {
        querySymbol,
        mappingContext,
        resolved: true,
        status: "resolved",
        resolvedSymbol: resolved,
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    if (strictCandidates.length > 1) {
      warnings.push("Exact method mapping is ambiguous for owner+method+descriptor.");
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "ambiguous",
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    if (pathUsesSource(graph.pairs, path, "mojang-client-mappings")) {
      warnings.push(
        "Method descriptor could not be preserved through mojang-client-mappings and exact resolution is unavailable."
      );
      return {
        querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings,
        provenance: this.provenanceForPath(graph, path)
      };
    }

    return {
      querySymbol,
      mappingContext,
      resolved: false,
      status: "not_found",
      candidates: limitedCandidates.candidates,
      candidateCount: limitedCandidates.candidateCount,
      candidatesTruncated: limitedCandidates.candidatesTruncated,
      warnings,
      provenance: this.provenanceForPath(graph, path)
    };
  }

  async getClassApiMatrix(input: ClassApiMatrixInput): Promise<ClassApiMatrixOutput> {
    const version = input.version.trim();
    const className = normalizeMappedSymbolOutput(input.className.trim());
    if (!version || !className) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version and className must be non-empty strings.",
        details: {
          version: input.version,
          className: input.className
        }
      });
    }

    const classNameMapping = input.classNameMapping;
    if (!SUPPORTED_MAPPINGS.has(classNameMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported classNameMapping.",
        details: {
          classNameMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const graph = await this.loadGraph(version, priority);
    const warnings = [...graph.warnings];
    const includeKinds = normalizeIncludedKinds(input.includeKinds);
    const pathCache = new Map<PairKey, SourceMapping[] | undefined>();
    const resolvePath = (
      sourceMapping: SourceMapping,
      targetMapping: SourceMapping
    ): SourceMapping[] | undefined => {
      if (sourceMapping === targetMapping) {
        return [sourceMapping];
      }
      const key = pairKey(sourceMapping, targetMapping);
      if (pathCache.has(key)) {
        return pathCache.get(key);
      }
      const path = namespacePath(graph, sourceMapping, targetMapping);
      pathCache.set(key, path);
      return path;
    };

    const classByMapping: Partial<Record<SourceMapping, MappingSymbolRecord>> = {
      [classNameMapping]: createClassSymbolRecord(className)
    };

    for (const mapping of SUPPORTED_MAPPINGS) {
      if (mapping === classNameMapping) {
        continue;
      }
      const mapped = this.mapRecordBetweenMappings(
        graph,
        classNameMapping,
        mapping,
        classByMapping[classNameMapping] as MappingSymbolRecord,
        resolvePath(classNameMapping, mapping)
      );
      if (mapped.length > 1) {
        const competing = mapped.slice(0, 5).map((c) => c.symbol);
        warnings.push(`Class identity mapping to ${mapping} is ambiguous for "${className}": competing=[${competing.join(", ")}].`);
      }
      if (mapped.length > 0) {
        classByMapping[mapping] = mapped[0];
      }
    }

    const baseMapping: SourceMapping = classByMapping.obfuscated ? "obfuscated" : classNameMapping;
    const baseClass = classByMapping[baseMapping];
    if (!baseClass) {
      return {
        version,
        className,
        classNameMapping,
        classIdentity: {
          obfuscated: classByMapping.obfuscated?.symbol,
          mojang: classByMapping.mojang?.symbol,
          intermediary: classByMapping.intermediary?.symbol,
          yarn: classByMapping.yarn?.symbol
        },
        rows: [],
        rowCount: 0,
        warnings
      };
    }

    const baseRecords = collectTargetRecords(graph, baseMapping).filter((record) => {
      if (record.kind === "class") {
        return includeKinds.has("class") && record.symbol === baseClass.symbol;
      }
      if (record.owner !== baseClass.symbol) {
        return false;
      }
      if (record.kind === "field") {
        return includeKinds.has("field");
      }
      return includeKinds.has("method");
    });

    const rows: ClassApiMatrixRow[] = [];
    let ambiguousRowCount = 0;
    const rowSeen = new Set<string>();
    const rowKindOrder: Record<ClassApiMatrixKind, number> = {
      class: 0,
      field: 1,
      method: 2
    };
    const sortedBase = [...baseRecords].sort((left, right) => {
      const leftKind = rowKindOrder[left.kind];
      const rightKind = rowKindOrder[right.kind];
      if (leftKind !== rightKind) {
        return leftKind - rightKind;
      }
      if ((left.descriptor ?? "") !== (right.descriptor ?? "")) {
        return (left.descriptor ?? "").localeCompare(right.descriptor ?? "");
      }
      return left.symbol.localeCompare(right.symbol);
    });

    for (const baseRecord of sortedBase) {
      const key = buildSymbolKey(baseRecord);
      if (rowSeen.has(key)) {
        continue;
      }
      rowSeen.add(key);
      let rowHadAmbiguity = false;

      const row: ClassApiMatrixRow = {
        kind: baseRecord.kind,
        descriptor: baseRecord.descriptor,
        completeness: false
      };

      for (const mapping of SUPPORTED_MAPPINGS) {
        const classIdentity = classByMapping[mapping];
        let resolved: MappingSymbolRecord | undefined;
        if (mapping === baseMapping) {
          resolved = baseRecord;
        } else {
          const mapped = this.mapRecordBetweenMappings(
            graph,
            baseMapping,
            mapping,
            baseRecord,
            resolvePath(baseMapping, mapping)
          );
          let filtered = mapped;
          if (baseRecord.kind !== "class" && classIdentity) {
            filtered = filtered.filter((candidate) => candidate.owner === classIdentity.symbol);
          }
          if (baseRecord.kind === "method" && baseRecord.descriptor) {
            const descriptorMatched = filtered.filter(
              (candidate) => candidate.descriptor === baseRecord.descriptor
            );
            if (descriptorMatched.length > 0) {
              filtered = descriptorMatched;
            }
          }
          if (filtered.length > 1) {
            const competing = filtered.slice(0, 5).map((c) => c.symbol);
            warnings.push(
              `Row mapping to ${mapping} is ambiguous for "${baseRecord.symbol}": competing=[${competing.join(", ")}]. Using highest-ranked candidate.`
            );
            rowHadAmbiguity = true;
          }
          resolved = filtered[0];
        }

        if (!resolved) {
          continue;
        }

        const entry: ClassApiMatrixEntry = {
          symbol: resolved.symbol,
          owner: resolved.owner,
          name: resolved.name,
          descriptor: resolved.descriptor
        };
        row[mapping] = entry;
      }

      row.completeness = Boolean(row.obfuscated && row.mojang && row.intermediary && row.yarn);
      rows.push(row);
      if (rowHadAmbiguity) {
        ambiguousRowCount += 1;
      }
    }

    const rowCount = rows.length;
    const rowLimit = clampRowLimit(input.maxRows);
    const limitedRows = rowLimit != null && rowCount > rowLimit ? rows.slice(0, rowLimit) : rows;

    return {
      version,
      className,
      classNameMapping,
      classIdentity: {
        obfuscated: classByMapping.obfuscated?.symbol,
        mojang: classByMapping.mojang?.symbol,
        intermediary: classByMapping.intermediary?.symbol,
        yarn: classByMapping.yarn?.symbol
      },
      rows: limitedRows,
      rowCount,
      rowsTruncated: limitedRows.length < rowCount ? true : undefined,
      warnings,
      ambiguousRowCount: ambiguousRowCount > 0 ? ambiguousRowCount : undefined
    };
  }

  async checkSymbolExists(input: SymbolExistenceInput): Promise<SymbolExistenceOutput> {
    const version = input.version.trim();
    if (!version) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "version must be non-empty.",
        details: {
          version: input.version
        }
      });
    }
    const sourceMapping = input.sourceMapping;
    if (!SUPPORTED_MAPPINGS.has(sourceMapping)) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: "Unsupported mapping namespace for existence check.",
        details: {
          sourceMapping
        }
      });
    }

    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const mappingContext = {
      version,
      sourceMapping,
      sourcePriorityApplied: priority
    } satisfies SymbolExistenceOutput["mappingContext"];

    const classNameMode = input.nameMode === "auto" ? "auto" : "fqcn";
    const normalizedQuery:
      | {
          mode: "auto-class";
          className: string;
          querySymbol: SymbolReference;
        }
      | {
          mode: "strict";
          queryRecord: MappingSymbolRecord;
          querySymbol: SymbolReference;
        } =
      input.kind === "class" && classNameMode === "auto"
        ? (() => {
            const owner = input.owner?.trim();
            if (owner) {
              throw invalidInputError("owner is not allowed when kind=class. Use name as FQCN.", {
                owner: input.owner,
                nextAction: 'Provide class as name, e.g. "net.minecraft.server.Main".'
              });
            }
            if (input.descriptor?.trim()) {
              throw invalidInputError("descriptor is not allowed when kind=class.", {
                descriptor: input.descriptor
              });
            }
            const autoClassName = normalizeMappedSymbolOutput(input.name.trim());
            if (!autoClassName) {
              throw invalidInputError("name must be a non-empty string.", {
                name: input.name
              });
            }
            return {
              mode: "auto-class",
              className: autoClassName,
              querySymbol: {
                kind: "class",
                name: autoClassName,
                symbol: autoClassName
              }
            };
          })()
        : (() => {
            const { record: queryRecord, querySymbol } = normalizeQuerySymbol(input, input.signatureMode);
            return {
              mode: "strict",
              queryRecord,
              querySymbol
            };
          })();

    const graph = await this.loadGraph(version, priority);
    const warnings = [...graph.warnings];
    const records = collectTargetRecords(graph, sourceMapping);
    if (records.length === 0) {
      return {
        querySymbol: normalizedQuery.querySymbol,
        mappingContext,
        resolved: false,
        status: "mapping_unavailable",
        candidates: [],
        candidateCount: 0,
        warnings
      };
    }

    const buildOutput = (
      querySymbol: SymbolReference,
      matched: MappingSymbolRecord[],
      status: SymbolResolutionStatus
    ): SymbolExistenceOutput => {
      const candidates = matched.map((record) => toResolutionCandidate(toLookupCandidate(record)));
      const limitedCandidates = limitResolutionCandidates(candidates, input.maxCandidates);
      return {
        querySymbol,
        mappingContext,
        resolved: status === "resolved",
        status,
        resolvedSymbol: status === "resolved" ? candidates[0] : undefined,
        candidates: limitedCandidates.candidates,
        candidateCount: limitedCandidates.candidateCount,
        candidatesTruncated: limitedCandidates.candidatesTruncated,
        warnings
      };
    };

    if (normalizedQuery.mode === "auto-class") {
      const autoClassName = normalizedQuery.className;
      if (autoClassName.includes(".")) {
        const matched = records.filter(
          (record) => record.kind === "class" && record.symbol === autoClassName
        );
        const status: SymbolResolutionStatus =
          matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
        return buildOutput(normalizedQuery.querySymbol, matched, status);
      }

      const matched = records.filter(
        (record) => record.kind === "class" && record.name === autoClassName
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      if (status === "ambiguous") {
        warnings.push(
          `Multiple class symbols matched short name "${autoClassName}". Provide fully-qualified class name.`
        );
      }
      return buildOutput(normalizedQuery.querySymbol, matched, status);
    }

    const { queryRecord, querySymbol } = normalizedQuery;

    if (queryRecord.kind === "class") {
      const matched = records.filter(
        (record) => record.kind === "class" && record.symbol === queryRecord.symbol
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      return buildOutput(querySymbol, matched, status);
    }

    if (queryRecord.kind === "field") {
      const matched = records.filter(
        (record) =>
          record.kind === "field" && record.owner === queryRecord.owner && record.name === queryRecord.name
      );
      const status: SymbolResolutionStatus =
        matched.length === 1 ? "resolved" : matched.length > 1 ? "ambiguous" : "not_found";
      return buildOutput(querySymbol, matched, status);
    }

    const methodCandidates = records.filter(
      (record) =>
        record.kind === "method" && record.owner === queryRecord.owner && record.name === queryRecord.name
    );

    // name-only mode: skip descriptor matching, resolve by owner+name
    if (input.signatureMode === "name-only") {
      const status: SymbolResolutionStatus =
        methodCandidates.length === 1 ? "resolved" : methodCandidates.length > 1 ? "ambiguous" : "not_found";
      if (status === "ambiguous") {
        warnings.push(
          `Multiple method overloads matched name "${queryRecord.name}" in owner "${queryRecord.owner}". Provide descriptor for exact match.`
        );
      }
      return buildOutput(querySymbol, methodCandidates, status);
    }

    const descriptorMatched = methodCandidates.filter(
      (record) => record.descriptor === queryRecord.descriptor
    );
    if (descriptorMatched.length === 1) {
      return buildOutput(querySymbol, descriptorMatched, "resolved");
    }
    if (descriptorMatched.length > 1) {
      return buildOutput(querySymbol, descriptorMatched, "ambiguous");
    }

    if (methodCandidates.some((candidate) => candidate.descriptor == null)) {
      warnings.push("Descriptor-level existence checks are unavailable for descriptorless mapping entries.");
      return buildOutput(querySymbol, methodCandidates, "mapping_unavailable");
    }

    return buildOutput(querySymbol, [], "not_found");
  }

  private mapRecordBetweenMappings(
    graph: LoadedGraph,
    sourceMapping: SourceMapping,
    targetMapping: SourceMapping,
    record: MappingSymbolRecord,
    resolvedPath?: SourceMapping[]
  ): MappingSymbolRecord[] {
    if (sourceMapping === targetMapping) {
      return [record];
    }
    const path = resolvedPath ?? namespacePath(graph, sourceMapping, targetMapping);
    if (!path) {
      return [];
    }

    let mapped = this
      .mapCandidatesAlongPath(graph, path, record)
      .filter((candidate) => candidate.kind === record.kind)
      .map((candidate) => ({
        kind: candidate.kind,
        symbol: candidate.symbol,
        owner: candidate.owner,
        name: candidate.name,
        descriptor: candidate.descriptor
      }));

    if (record.kind === "method" && record.descriptor) {
      const descriptorMatched = mapped.filter((candidate) => candidate.descriptor === record.descriptor);
      if (descriptorMatched.length > 0) {
        mapped = descriptorMatched;
      }
    }

    const deduped = new Map<string, MappingSymbolRecord>();
    for (const candidate of mapped) {
      deduped.set(buildSymbolKey(candidate), candidate);
    }
    return [...deduped.values()];
  }

  private mapCandidatesAlongPath(
    graph: LoadedGraph,
    path: SourceMapping[],
    query: MappingSymbolRecord
  ): MappingLookupCandidate[] {
    const queryKey = buildSymbolKey(query);
    let current = new Map<string, CandidateAccumulator>([
      [
        queryKey,
        {
          key: queryKey,
          record: query,
          matchKind: "exact",
          confidence: 1,
          rank: MATCH_RANK.exact
        }
      ]
    ]);

    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index];
      const to = path[index + 1];
      const record = graph.pairs.get(pairKey(from, to));
      if (!record) {
        return [];
      }

      const next = new Map<string, CandidateAccumulator>();
      for (const candidate of current.values()) {
        const mapped = lookupCandidates(record.index, candidate.record);
        for (const item of mapped) {
          const mappedRecord: MappingSymbolRecord = {
            kind: item.kind,
            symbol: item.symbol,
            owner: item.owner,
            name: item.name,
            descriptor: item.descriptor
          };
          const mappedKey = buildSymbolKey(mappedRecord);
          const rank = MATCH_RANK[item.matchKind];
          const composedConfidence = candidate.confidence * item.confidence;
          const existing = next.get(mappedKey);
          if (
            !existing ||
            composedConfidence > existing.confidence ||
            (composedConfidence === existing.confidence && rank > existing.rank)
          ) {
            next.set(mappedKey, {
              key: mappedKey,
              record: mappedRecord,
              matchKind: item.matchKind,
              confidence: composedConfidence,
              rank
            });
          }
        }
      }

      current = next;
      if (current.size === 0) {
        return [];
      }
    }

    return [...current.values()]
      .sort((left, right) => {
        if (right.confidence !== left.confidence) {
          return right.confidence - left.confidence;
        }
        if (right.rank !== left.rank) {
          return right.rank - left.rank;
        }
        return left.record.symbol.localeCompare(right.record.symbol);
      })
      .slice(0, MAX_CANDIDATES)
      .map((item) => ({
        symbol: item.record.symbol,
        matchKind: item.matchKind,
        confidence: Number(item.confidence.toFixed(6)),
        kind: item.record.kind,
        owner: item.record.owner,
        name: item.record.name,
        descriptor: item.record.descriptor
      }));
  }

  private provenanceForPath(
    graph: LoadedGraph,
    path: SourceMapping[]
  ): MappingLookupProvenance | undefined {
    if (path.length <= 1) {
      return undefined;
    }
    const first = graph.pairs.get(pairKey(path[0], path[1]));
    if (!first) {
      return undefined;
    }
    return {
      source: first.source,
      mappingArtifact: first.mappingArtifact,
      version: graph.version,
      priority: graph.priority
    };
  }

  /**
   * Probe the mapping graph health for a given version.
   * Returns availability of mojang mappings, tiny mappings, and member remap paths.
   */
  async checkMappingHealth(input: {
    version: string;
    requestedMapping: SourceMapping;
    sourcePriority?: MappingSourcePriority;
  }): Promise<{
    mojangMappingsAvailable: boolean;
    tinyMappingsAvailable: boolean;
    memberRemapAvailable: boolean;
    degradations: string[];
  }> {
    const priority = mappingPriorityFromInput(this.config.mappingSourcePriority, input.sourcePriority);
    const degradations: string[] = [];

    let graph: LoadedGraph;
    try {
      graph = await this.loadGraph(input.version, priority);
    } catch {
      return {
        mojangMappingsAvailable: false,
        tinyMappingsAvailable: false,
        memberRemapAvailable: false,
        degradations: ["Mapping graph could not be loaded."]
      };
    }

    // Check for mojang-client-mappings pairs
    let mojangAvailable = false;
    let tinyAvailable = false;
    for (const [, record] of graph.pairs) {
      if (record.source === "mojang-client-mappings") mojangAvailable = true;
      if (record.source === "loom-cache" || record.source === "maven") tinyAvailable = true;
    }

    if (!mojangAvailable) {
      degradations.push("Mojang client mappings are not available for this version.");
    }
    if (!tinyAvailable) {
      degradations.push("No intermediary/yarn tiny mappings were found for this version.");
    }

    // Check if member remap path exists (requestedMapping → obfuscated)
    let memberRemapAvailable = false;
    if (input.requestedMapping === "obfuscated") {
      memberRemapAvailable = true;
    } else {
      const path = namespacePath(graph, input.requestedMapping, "obfuscated");
      memberRemapAvailable = path != null && path.length > 1;
      if (!memberRemapAvailable) {
        degradations.push(`No mapping path from ${input.requestedMapping} to obfuscated; member remap will fail.`);
      }
    }

    return {
      mojangMappingsAvailable: mojangAvailable,
      tinyMappingsAvailable: tinyAvailable,
      memberRemapAvailable,
      degradations
    };
  }

  private async loadGraph(version: string, priority: MappingSourcePriority): Promise<LoadedGraph> {
    const cacheKey = `${version}|${priority}`;
    const cached = this.graphCache.get(cacheKey);
    if (cached) {
      this.graphCache.delete(cacheKey);
      this.graphCache.set(cacheKey, cached);
      return cached;
    }

    const existingLock = this.buildLocks.get(cacheKey);
    if (existingLock) {
      return existingLock;
    }

    const buildPromise = this.buildGraph(version, priority);
    this.buildLocks.set(cacheKey, buildPromise);
    try {
      const built = await buildPromise;
      this.graphCache.set(cacheKey, built);
      this.trimGraphCache();
      return built;
    } finally {
      this.buildLocks.delete(cacheKey);
    }
  }

  private async buildGraph(version: string, priority: MappingSourcePriority): Promise<LoadedGraph> {
    if (isUnobfuscatedVersion(version)) {
      return {
        version,
        priority,
        pairs: new Map(),
        adjacency: new Map(),
        pathCache: new Map(),
        recordsByTarget: new Map(),
        warnings: [
          `Version ${version} is unobfuscated; mapping graph is empty because the runtime already uses deobfuscated names.`
        ]
      };
    }

    const graph: LoadedGraph = {
      version,
      priority,
      pairs: new Map(),
      adjacency: new Map(),
      pathCache: new Map(),
      recordsByTarget: new Map(),
      warnings: []
    };

    const mojangLoad = await this.loadMojangPairs(version);
    graph.warnings.push(...mojangLoad.warnings);
    this.mergePairs(graph.pairs, mojangLoad.pairs, "mojang-client-mappings", mojangLoad.mappingArtifact);

    let tinyLoaded = false;
    const deferredTinyWarnings: string[] = [];
    for (const source of mappingSourceOrder(priority)) {
      const tinyLoad =
        source === "loom-cache"
          ? await this.loadTinyPairsFromLoom(version)
          : await this.loadTinyPairsFromMaven(version);
      if (tinyLoad.pairs.size === 0) {
        deferredTinyWarnings.push(...tinyLoad.warnings);
        continue;
      }

      tinyLoaded = true;
      this.mergePairs(graph.pairs, tinyLoad.pairs, source, tinyLoad.mappingArtifact);
      graph.warnings.push(...tinyLoad.warnings);
      if (deferredTinyWarnings.length > 0) {
        graph.warnings.push(
          `Used ${source === "maven" ? "Maven" : "Loom cache"} tiny mappings for "${version}" after an earlier source lookup returned no data.`
        );
      }
      break;
    }

    if (!tinyLoaded) {
      graph.warnings.push(...deferredTinyWarnings);
      graph.warnings.push("No intermediary/yarn tiny mappings were found for this version.");
    }

    graph.adjacency = buildAdjacency(graph.pairs);
    graph.recordsByTarget = buildTargetRecordIndex(graph.pairs);

    return graph;
  }

  private mergePairs(
    target: Map<PairKey, PairRecord>,
    source: Map<PairKey, DirectionIndex>,
    pairSource: MappingLookupSource,
    mappingArtifact: string
  ): void {
    for (const [key, incoming] of source.entries()) {
      const existing = target.get(key);
      if (!existing) {
        target.set(key, {
          index: incoming,
          source: pairSource,
          mappingArtifact
        });
        continue;
      }
      if (existing.source !== pairSource) {
        continue;
      }
      mergeDirectionIndexes(existing.index, incoming);
    }
  }

  private async loadMojangPairs(version: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const warnings: string[] = [];
    let metadata: ResolvedVersionMappings;
    try {
      metadata = await this.versionService.resolveVersionMappings(version);
    } catch (caughtError) {
      return {
        pairs: new Map(),
        warnings: [
          `Failed to resolve version metadata for "${version}": ${
            caughtError instanceof Error ? caughtError.message : String(caughtError)
          }`
        ],
        mappingArtifact: `version:${version}`
      };
    }

    const clientMappingsUrl = metadata.clientMappingsUrl ?? metadata.mappingsUrl;
    if (!clientMappingsUrl) {
      warnings.push(`Minecraft version "${version}" does not expose client mappings URL.`);
      return {
        pairs: new Map(),
        warnings,
        mappingArtifact: metadata.versionDetailUrl
      };
    }

    const mappingsPath = join(this.config.cacheDir, "mappings", version, "client_mappings.txt");
    if (!existsSync(mappingsPath)) {
      await mkdir(dirname(mappingsPath), { recursive: true });
      const downloaded = await downloadToCache(clientMappingsUrl, mappingsPath, {
        fetchFn: this.fetchFn,
        retries: this.config.fetchRetries,
        timeoutMs: this.config.fetchTimeoutMs
      });
      if (!downloaded.ok || !downloaded.path) {
        warnings.push(
          `Failed to download client mappings from "${clientMappingsUrl}" (status: ${downloaded.statusCode ?? "unknown"}).`
        );
        return {
          pairs: new Map(),
          warnings,
          mappingArtifact: clientMappingsUrl
        };
      }
    }

    try {
      const content = await readFile(mappingsPath, "utf8");
      return {
        pairs: parseClientMappings(content),
        warnings,
        mappingArtifact: clientMappingsUrl
      };
    } catch (caughtError) {
      warnings.push(
        `Failed to parse client mappings for "${version}": ${
          caughtError instanceof Error ? caughtError.message : String(caughtError)
        }`
      );
      return {
        pairs: new Map(),
        warnings,
        mappingArtifact: clientMappingsUrl
      };
    }
  }

  private async loadTinyPairsFromLoom(version: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const patterns = [".gradle/loom-cache/**/*.tiny", ".gradle/loom-cache/**/*.tinyv2"];
    const candidates = fastGlob.sync(patterns, {
      cwd: process.cwd(),
      absolute: true,
      onlyFiles: true
    });
    const byVersion = candidates
      .filter((p) => p.replaceAll("\\", "/").includes(`/${version}/`))
      .sort((left, right) => left.localeCompare(right));
    if (byVersion.length === 0) {
      return {
        pairs: new Map(),
        warnings: [`No Loom tiny mapping files matched version "${version}".`],
        mappingArtifact: "loom-cache:none"
      };
    }

    const merged = new Map<PairKey, DirectionIndex>();
    for (const path of byVersion) {
      try {
        const content = await readFile(path, "utf8");
        const parsed = parseTinyMappings(content);
        for (const [key, index] of parsed.entries()) {
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, index);
          } else {
            mergeDirectionIndexes(existing, index);
          }
        }
      } catch {
        // best effort: skip unreadable or invalid files
      }
    }

    return {
      pairs: merged,
      warnings: [],
      mappingArtifact: byVersion[0]
    };
  }

  private async loadTinyPairsFromMaven(version: string): Promise<{
    pairs: Map<PairKey, DirectionIndex>;
    warnings: string[];
    mappingArtifact: string;
  }> {
    const warnings: string[] = [];
    const merged = new Map<PairKey, DirectionIndex>();

    const repos = this.config.sourceRepos;
    const intermediaryUrls: string[] = [];
    const yarnUrls: string[] = [];

    const repoBases = repos.map((repo) => repo.replace(/\/+$/, ""));
    const yarnCoordinatesByRepo = await Promise.all(
      repoBases.map(async (base) => ({
        base,
        yarnCoordinates: await this.fetchYarnCoordinates(base, version)
      }))
    );

    for (const { base, yarnCoordinates } of yarnCoordinatesByRepo) {
      intermediaryUrls.push(
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`,
        `${base}/net/fabricmc/intermediary/${version}/intermediary-${version}.jar`
      );

      for (const coordinate of yarnCoordinates) {
        yarnUrls.push(
          `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}-v2.jar`,
          `${base}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}.jar`
        );
      }
    }

    const allUrls = [...intermediaryUrls, ...yarnUrls];
    const parsedResults = await Promise.allSettled(
      allUrls.map(async (url) => {
        const downloaded = await downloadToCache(url, defaultDownloadPath(this.config.cacheDir, url), {
          fetchFn: this.fetchFn,
          retries: this.config.fetchRetries,
          timeoutMs: this.config.fetchTimeoutMs
        });
        if (!downloaded.ok || !downloaded.path) {
          return undefined;
        }

        return this.parseTinyFromJar(downloaded.path);
      })
    );

    for (const result of parsedResults) {
      if (result.status !== "fulfilled" || !result.value) {
        continue;
      }
      for (const [key, index] of result.value.entries()) {
        const existing = merged.get(key);
        if (!existing) {
          merged.set(key, index);
        } else {
          mergeDirectionIndexes(existing, index);
        }
      }
    }

    if (merged.size === 0) {
      warnings.push(`No Maven tiny mappings could be loaded for "${version}".`);
    }

    return {
      pairs: merged,
      warnings,
      mappingArtifact: allUrls[0] ?? "maven:none"
    };
  }

  private async parseTinyFromJar(jarPath: string): Promise<Map<PairKey, DirectionIndex>> {
    const entries = await listJarEntries(jarPath);
    const tinyEntries = entries
      .filter((entry) => entry.toLowerCase().endsWith(".tiny") || entry.toLowerCase().endsWith(".tinyv2"))
      .sort((left, right) => left.localeCompare(right));

    const merged = new Map<PairKey, DirectionIndex>();
    for (const entry of tinyEntries) {
      try {
        const text = await readJarEntryAsUtf8(jarPath, entry);
        const parsed = parseTinyMappings(text);
        for (const [key, index] of parsed.entries()) {
          const existing = merged.get(key);
          if (!existing) {
            merged.set(key, index);
          } else {
            mergeDirectionIndexes(existing, index);
          }
        }
      } catch {
        // skip malformed tiny entries
      }
    }

    return merged;
  }

  private async fetchYarnCoordinates(repoBase: string, version: string): Promise<string[]> {
    const metadataUrl = `${repoBase}/net/fabricmc/yarn/maven-metadata.xml`;
    try {
      const response = await this.fetchFn(metadataUrl);
      if (!response.ok) {
        return [];
      }
      const xml = await response.text();
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
        .map((match) => match[1]?.trim() ?? "")
        .filter((value) => value.startsWith(`${version}+build.`));

      const sorted = versions.sort((left, right) => {
        const leftBuild = Number.parseInt(left.split("+build.")[1] ?? "0", 10);
        const rightBuild = Number.parseInt(right.split("+build.")[1] ?? "0", 10);
        return rightBuild - leftBuild;
      });

      if (sorted.length > 0) {
        return sorted.slice(0, 3);
      }
      return [version];
    } catch {
      return [version];
    }
  }

  private trimGraphCache(): void {
    const maxEntries = Math.max(1, this.config.maxMappingGraphCache ?? 16);
    while (this.graphCache.size > maxEntries) {
      const oldestKey = this.graphCache.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.graphCache.delete(oldestKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone: Tiny v2 mapping file resolution for remapping
// ---------------------------------------------------------------------------

const FABRIC_MAVEN = "https://maven.fabricmc.net";

async function fetchYarnCoordinatesStandalone(
  version: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<string[]> {
  const metadataUrl = `${FABRIC_MAVEN}/net/fabricmc/yarn/maven-metadata.xml`;
  try {
    const response = await fetchFn(metadataUrl);
    if (!response.ok) {
      return [];
    }
    const xml = await response.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((value) => value.startsWith(`${version}+build.`));

    const sorted = versions.sort((left, right) => {
      const leftBuild = Number.parseInt(left.split("+build.")[1] ?? "0", 10);
      const rightBuild = Number.parseInt(right.split("+build.")[1] ?? "0", 10);
      return rightBuild - leftBuild;
    });

    return sorted.length > 0 ? sorted.slice(0, 3) : [];
  } catch {
    return [];
  }
}

async function extractTinyFromJar(
  jarPath: string,
  outputPath: string
): Promise<boolean> {
  const entries = await listJarEntries(jarPath);
  const tinyEntry = entries.find(
    (entry) => entry === "mappings/mappings.tiny" || entry.toLowerCase().endsWith(".tiny")
  );
  if (!tinyEntry) {
    return false;
  }

  const content = await readJarEntryAsUtf8(jarPath, tinyEntry);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  return true;
}

/**
 * Resolve and cache a Tiny v2 mapping file for the given Minecraft version.
 *
 * @param version - Minecraft version (e.g. "1.20.4")
 * @param mapping - "intermediary" or "yarn"
 * @param cacheDir - The application cache directory
 * @param fetchFn - Optional fetch implementation for testing
 * @returns Path to the extracted Tiny v2 file
 */
export async function resolveTinyMappingFile(
  version: string,
  mapping: "intermediary" | "yarn",
  cacheDir: string,
  fetchFn?: typeof fetch
): Promise<string> {
  const cachedTiny = join(cacheDir, "mappings", `${version}-${mapping}.tiny`);

  if (existsSync(cachedTiny)) {
    return cachedTiny;
  }

  const effectiveFetch = fetchFn ?? globalThis.fetch;

  if (mapping === "intermediary") {
    const url = `${FABRIC_MAVEN}/net/fabricmc/intermediary/${version}/intermediary-${version}-v2.jar`;
    const jarDest = defaultDownloadPath(cacheDir, url);
    const downloaded = await downloadToCache(url, jarDest, {
      fetchFn: effectiveFetch,
      retries: 2,
      timeoutMs: 30_000
    });

    if (!downloaded.ok || !downloaded.path) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `Failed to download intermediary mappings for ${version}.`,
        details: { version, url }
      });
    }

    const extracted = await extractTinyFromJar(downloaded.path, cachedTiny);
    if (!extracted) {
      throw createError({
        code: ERROR_CODES.MAPPING_UNAVAILABLE,
        message: `No tiny mapping found in intermediary JAR for ${version}.`,
        details: { version, jarPath: downloaded.path }
      });
    }

    return cachedTiny;
  }

  // yarn
  const yarnCoordinates = await fetchYarnCoordinatesStandalone(version, effectiveFetch);
  if (yarnCoordinates.length === 0) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `No yarn builds found for Minecraft ${version}.`,
      details: { version }
    });
  }

  for (const coordinate of yarnCoordinates) {
    const url = `${FABRIC_MAVEN}/net/fabricmc/yarn/${coordinate}/yarn-${coordinate}-v2.jar`;
    const jarDest = defaultDownloadPath(cacheDir, url);
    const downloaded = await downloadToCache(url, jarDest, {
      fetchFn: effectiveFetch,
      retries: 2,
      timeoutMs: 30_000
    });

    if (!downloaded.ok || !downloaded.path) {
      continue;
    }

    const extracted = await extractTinyFromJar(downloaded.path, cachedTiny);
    if (extracted) {
      return cachedTiny;
    }
  }

  throw createError({
    code: ERROR_CODES.MAPPING_UNAVAILABLE,
    message: `Failed to download yarn mappings for ${version}.`,
    details: { version, triedCoordinates: yarnCoordinates }
  });
}
