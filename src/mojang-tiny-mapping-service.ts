import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { downloadToCache } from "./repo-downloader.js";
import type { Config } from "./types.js";
import { type ResolvedVersionMappings, VersionService } from "./version-service.js";

interface RawClassMapping {
  mojangFqn: string;
  officialInternal: string;
}

interface RawMemberMapping {
  ownerMojangFqn: string;
  leftSignature: string;
  officialName: string;
}

interface ParsedProguardMappings {
  classes: RawClassMapping[];
  members: RawMemberMapping[];
}

interface TinyMemberRecord {
  kind: "f" | "m";
  descriptor: string;
  officialName: string;
  mojangName: string;
}

type VersionMappingsResolver = Pick<VersionService, "resolveVersionMappings">;

export interface ResolveMojangTinyDeps {
  fetchFn?: typeof fetch;
  versionService?: VersionMappingsResolver;
}

export interface ResolveMojangTinyResult {
  path: string;
  warnings: string[];
}

function stripLineInfo(input: string): string {
  let value = input.trim();
  while (/^\d+:\d+:/.test(value)) {
    value = value.replace(/^\d+:\d+:/, "");
  }
  return value.replace(/:\d+:\d+$/, "").trim();
}

function normalizeFqn(value: string): string {
  return value.trim().replace(/\//g, ".");
}

function normalizeInternalName(value: string): string {
  return value.trim().replace(/\./g, "/");
}

function parseProguardMappings(text: string): ParsedProguardMappings {
  const classes: RawClassMapping[] = [];
  const members: RawMemberMapping[] = [];
  let currentClass: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const classMatch = /^(.+?)\s+->\s+(.+):$/.exec(line);
    if (classMatch) {
      const mojangFqn = normalizeFqn(classMatch[1] ?? "");
      const officialInternal = normalizeInternalName(classMatch[2] ?? "");
      if (!mojangFqn || !officialInternal) {
        currentClass = undefined;
        continue;
      }
      currentClass = mojangFqn;
      classes.push({ mojangFqn, officialInternal });
      continue;
    }

    if (!currentClass) {
      continue;
    }

    const arrowIndex = line.indexOf(" -> ");
    if (arrowIndex < 0) {
      continue;
    }
    const leftRaw = stripLineInfo(line.slice(0, arrowIndex));
    const officialName = line.slice(arrowIndex + 4).trim();
    if (!leftRaw || !officialName) {
      continue;
    }
    members.push({
      ownerMojangFqn: currentClass,
      leftSignature: leftRaw,
      officialName
    });
  }

  return { classes, members };
}

function stripGenericTypes(value: string): string {
  let depth = 0;
  let output = "";
  for (const char of value) {
    if (char === "<") {
      depth += 1;
      continue;
    }
    if (char === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      output += char;
    }
  }
  return output;
}

function splitMethodArgs(argList: string): string[] {
  const trimmed = argList.trim();
  if (!trimmed) {
    return [];
  }

  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of trimmed) {
    if (char === "<") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ">") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function typeToDescriptor(typeName: string, classMap: Map<string, string>): string | undefined {
  const primitive: Record<string, string> = {
    byte: "B",
    char: "C",
    double: "D",
    float: "F",
    int: "I",
    long: "J",
    short: "S",
    boolean: "Z",
    void: "V"
  };

  let value = stripGenericTypes(typeName).trim();
  if (!value) {
    return undefined;
  }

  value = value.replace(/\s+/g, "");
  let dimensions = 0;
  while (value.endsWith("[]")) {
    dimensions += 1;
    value = value.slice(0, -2);
  }
  if (value.endsWith("...")) {
    dimensions += 1;
    value = value.slice(0, -3);
  }

  const primitiveDescriptor = primitive[value];
  if (primitiveDescriptor) {
    return `${"[".repeat(dimensions)}${primitiveDescriptor}`;
  }

  const normalized = normalizeFqn(value);
  const internal = classMap.get(normalized) ?? normalized.replace(/\./g, "/");
  return `${"[".repeat(dimensions)}L${internal};`;
}

function buildMethodDescriptor(
  returnType: string,
  params: string[],
  classMap: Map<string, string>
): string | undefined {
  const paramDescriptors: string[] = [];
  for (const param of params) {
    const descriptor = typeToDescriptor(param, classMap);
    if (!descriptor) {
      return undefined;
    }
    paramDescriptors.push(descriptor);
  }

  const returnDescriptor = typeToDescriptor(returnType, classMap);
  if (!returnDescriptor) {
    return undefined;
  }
  return `(${paramDescriptors.join("")})${returnDescriptor}`;
}

function normalizeMemberMappings(
  rawMappings: ParsedProguardMappings[],
  classMap: Map<string, string>,
  warnings: string[]
): Map<string, TinyMemberRecord[]> {
  const membersByOwner = new Map<string, TinyMemberRecord[]>();
  const seen = new Set<string>();

  for (const mapping of rawMappings) {
    for (const member of mapping.members) {
      const ownerOfficial = classMap.get(normalizeFqn(member.ownerMojangFqn));
      if (!ownerOfficial) {
        warnings.push(
          `Skipping member mapping for "${member.ownerMojangFqn}" because class mapping is missing.`
        );
        continue;
      }

      const methodMatch = /^(.+?)\s+([^\s(]+)\((.*)\)$/.exec(member.leftSignature);
      let record: TinyMemberRecord | undefined;
      if (methodMatch) {
        const returnType = methodMatch[1]?.trim() ?? "";
        const mojangName = methodMatch[2]?.trim() ?? "";
        const params = splitMethodArgs(methodMatch[3] ?? "");
        const descriptor = buildMethodDescriptor(returnType, params, classMap);
        if (!mojangName || !descriptor) {
          warnings.push(
            `Skipping method mapping "${member.leftSignature}" because descriptor conversion failed.`
          );
          continue;
        }
        record = {
          kind: "m",
          descriptor,
          officialName: member.officialName,
          mojangName
        };
      } else {
        const fieldMatch = /^(.+?)\s+([^\s]+)$/.exec(member.leftSignature);
        if (!fieldMatch) {
          warnings.push(`Skipping unsupported member mapping syntax "${member.leftSignature}".`);
          continue;
        }
        const fieldType = fieldMatch[1]?.trim() ?? "";
        const mojangName = fieldMatch[2]?.trim() ?? "";
        const descriptor = typeToDescriptor(fieldType, classMap);
        if (!mojangName || !descriptor) {
          warnings.push(
            `Skipping field mapping "${member.leftSignature}" because descriptor conversion failed.`
          );
          continue;
        }
        record = {
          kind: "f",
          descriptor,
          officialName: member.officialName,
          mojangName
        };
      }

      const dedupeKey =
        `${ownerOfficial}|${record.kind}|${record.officialName}|` +
        `${record.mojangName}|${record.descriptor}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      const list = membersByOwner.get(ownerOfficial) ?? [];
      list.push(record);
      membersByOwner.set(ownerOfficial, list);
    }
  }

  return membersByOwner;
}

function mergeClasses(
  rawMappings: ParsedProguardMappings[],
  warnings: string[]
): Map<string, string> {
  const classMap = new Map<string, string>();
  for (const mapping of rawMappings) {
    for (const clazz of mapping.classes) {
      const mojang = normalizeFqn(clazz.mojangFqn);
      const official = normalizeInternalName(clazz.officialInternal);
      const existing = classMap.get(mojang);
      if (existing && existing !== official) {
        warnings.push(
          `Conflicting class mapping for "${mojang}" (${existing} vs ${official}); keeping first.`
        );
        continue;
      }
      classMap.set(mojang, official);
    }
  }
  return classMap;
}

function renderTinyV2(
  classMap: Map<string, string>,
  membersByOwner: Map<string, TinyMemberRecord[]>
): string {
  const classEntries = [...classMap.entries()]
    .map(([mojangFqn, officialInternal]) => ({
      officialInternal,
      mojangInternal: mojangFqn.replace(/\./g, "/")
    }))
    .sort((left, right) => left.officialInternal.localeCompare(right.officialInternal));

  const lines: string[] = ["tiny\t2\t0\tofficial\tmojang"];

  for (const entry of classEntries) {
    lines.push(`c\t${entry.officialInternal}\t${entry.mojangInternal}`);
    const members = [...(membersByOwner.get(entry.officialInternal) ?? [])].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind.localeCompare(right.kind);
      }
      if (left.officialName !== right.officialName) {
        return left.officialName.localeCompare(right.officialName);
      }
      return left.descriptor.localeCompare(right.descriptor);
    });
    for (const member of members) {
      lines.push(
        `\t${member.kind}\t${member.descriptor}\t${member.officialName}\t${member.mojangName}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

async function ensureMappingsFile(
  label: "client" | "server",
  version: string,
  url: string | undefined,
  config: Config,
  fetchFn: typeof fetch
): Promise<{ path?: string; warning?: string }> {
  if (!url) {
    return { warning: `${label} mappings URL is not available for ${version}.` };
  }

  const destination = join(config.cacheDir, "mappings", version, `${label}_mappings.txt`);
  if (!existsSync(destination)) {
    await mkdir(dirname(destination), { recursive: true });
    const downloaded = await downloadToCache(url, destination, {
      fetchFn,
      retries: config.fetchRetries,
      timeoutMs: config.fetchTimeoutMs
    });
    if (!downloaded.ok || !downloaded.path) {
      return {
        warning:
          `Failed to download ${label} mappings for ${version} from "${url}" ` +
          `(status: ${downloaded.statusCode ?? "unknown"}).`
      };
    }
  }

  return { path: destination };
}

function resolveMappingsUrls(metadata: ResolvedVersionMappings): {
  clientUrl: string | undefined;
  serverUrl: string | undefined;
} {
  return {
    clientUrl: metadata.clientMappingsUrl ?? metadata.mappingsUrl,
    serverUrl: metadata.serverMappingsUrl
  };
}

export async function resolveMojangTinyFile(
  version: string,
  config: Config,
  deps: ResolveMojangTinyDeps = {}
): Promise<ResolveMojangTinyResult> {
  const cachedTiny = join(config.cacheDir, "mappings", `${version}-mojang-merged.tiny`);
  if (existsSync(cachedTiny)) {
    return { path: cachedTiny, warnings: [] };
  }

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const versionService = deps.versionService ?? new VersionService(config, fetchFn);
  const metadata = await versionService.resolveVersionMappings(version);
  const { clientUrl, serverUrl } = resolveMappingsUrls(metadata);

  if (!clientUrl && !serverUrl) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `Minecraft version "${version}" does not expose Mojang mappings URLs.`,
      details: { version, versionDetailUrl: metadata.versionDetailUrl }
    });
  }

  const warnings: string[] = [];
  const [clientResult, serverResult] = await Promise.all([
    ensureMappingsFile("client", version, clientUrl, config, fetchFn),
    ensureMappingsFile("server", version, serverUrl, config, fetchFn)
  ]);

  if (clientResult.warning) {
    warnings.push(clientResult.warning);
  }
  if (serverResult.warning) {
    warnings.push(serverResult.warning);
  }

  const sourcePaths = [clientResult.path, serverResult.path].filter(
    (value): value is string => typeof value === "string"
  );
  if (sourcePaths.length === 0) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `Failed to retrieve Mojang mappings for "${version}".`,
      details: { version, clientUrl, serverUrl }
    });
  }

  const parsedMappings: ParsedProguardMappings[] = [];
  for (const path of sourcePaths) {
    const content = await readFile(path, "utf8");
    parsedMappings.push(parseProguardMappings(content));
  }

  const classMap = mergeClasses(parsedMappings, warnings);
  if (classMap.size === 0) {
    throw createError({
      code: ERROR_CODES.MAPPING_UNAVAILABLE,
      message: `No class mappings could be parsed for "${version}".`,
      details: { version, sourcePaths }
    });
  }

  const membersByOwner = normalizeMemberMappings(parsedMappings, classMap, warnings);
  const tinyContent = renderTinyV2(classMap, membersByOwner);

  await mkdir(dirname(cachedTiny), { recursive: true });
  await writeFile(cachedTiny, tinyContent, "utf8");

  log("info", "mojang-tiny.generated", {
    version,
    path: cachedTiny,
    classes: classMap.size,
    warnings: warnings.length
  });

  return { path: cachedTiny, warnings };
}
