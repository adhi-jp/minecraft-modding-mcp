/**
 * Proguard client-mappings parser. Two-pass: first pass collects
 * mojang→obfuscated class name mappings; second pass parses members with
 * descriptors. Pure; extracted from `src/mapping-service.ts`.
 */

import { ERROR_CODES, createError } from "../../errors.js";
import type { DirectionIndex, PairKey } from "../internal-types.js";
import {
  addLookupEntries,
  createClassSymbolRecord,
  createDirectionIndex,
  createFieldSymbolRecord,
  createMethodSymbolRecord,
  parseFieldName,
  stripLineInfo
} from "./symbol-records.js";
import { pairKey } from "./normalize.js";

/** Map of proguard primitive type names to JVM type characters. */
export const PROGUARD_PRIMITIVES: Record<string, string> = {
  void: "V", boolean: "Z", byte: "B", char: "C",
  short: "S", int: "I", long: "J", float: "F", double: "D"
};

/**
 * Convert a single proguard type (e.g. "int", "net.minecraft.Foo", "int[][]")
 * to JVM notation (e.g. "I", "Lnet/minecraft/Foo;", "[[I").
 * `classLookup` maps mojang class names → obfuscated class names (for the obfuscated descriptor).
 * Pass `undefined` to skip class name translation (for mojang descriptors).
 */
export function proguardTypeToJvm(type: string, classLookup: Map<string, string> | undefined): string {
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
export function parseProguardMethod(
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

export function parseClientMappings(text: string): Map<PairKey, DirectionIndex> {
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
