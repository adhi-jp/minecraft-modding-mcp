import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import fastGlob from "fast-glob";

import { mapWithConcurrencyLimit } from "./concurrency.js";
import { createError, ERROR_CODES } from "./errors.js";
import type { SourceMapping } from "./types.js";

const WORKSPACE_FILE_READ_CONCURRENCY = 4;

export type WorkspaceCompileMappingInput = {
  projectPath: string;
};

export type WorkspaceMappingEvidence = {
  filePath: string;
  mapping: SourceMapping;
  reason: string;
};

export type WorkspaceCompileMappingOutput = {
  resolved: boolean;
  mappingApplied?: SourceMapping;
  evidence: WorkspaceMappingEvidence[];
  warnings: string[];
};

export type WorkspaceProjectLoader = "fabric" | "quilt" | "forge" | "neoforge" | "unknown";

export type WorkspaceLoaderEvidence = {
  filePath: string;
  loader: WorkspaceProjectLoader;
  reason: string;
};

export type WorkspaceProjectLoaderOutput = {
  resolved: boolean;
  loader?: WorkspaceProjectLoader;
  evidence: WorkspaceLoaderEvidence[];
  warnings: string[];
};

export type DependencyVersionResolution =
  | {
      resolved: true;
      version: string;
      source: string;
      candidatesSeen: string[];
      attempts: string[];
      submoduleVersionSource?: "umbrella-pom";
    }
  | {
      resolved: false;
      candidatesSeen: string[];
      attempts: string[];
    };

export type DependencyVersionOptions = {
  includeSnapshots?: boolean;
};

type MappingDetection = {
  mapping: SourceMapping;
  reason: string;
};

type LoaderDetection = {
  loader: WorkspaceProjectLoader;
  reason: string;
};

function detectMappingsFromContent(content: string): MappingDetection[] {
  const detections: MappingDetection[] = [];
  if (/officialMojangMappings\s*\(/i.test(content)) {
    detections.push({
      mapping: "mojang",
      reason: "officialMojangMappings()"
    });
  }
  if (/\bmappings\s*(?:\(|)\s*["']net\.fabricmc:yarn:/i.test(content)) {
    detections.push({
      mapping: "yarn",
      reason: "mappings net.fabricmc:yarn"
    });
  }
  if (/\bmappings\s*(?:\(|)\s*["']net\.fabricmc:intermediary:/i.test(content)) {
    detections.push({
      mapping: "intermediary",
      reason: "mappings net.fabricmc:intermediary"
    });
  }
  if (/\bid\s*(?:\(\s*)?["']net\.neoforged\.moddev["']\s*\)?/i.test(content)) {
    detections.push({
      mapping: "mojang",
      reason: "net.neoforged.moddev plugin"
    });
  }
  if (/\bneoForge\s*\{[\s\S]*?\bparchment\s*\{/i.test(content)) {
    detections.push({
      mapping: "mojang",
      reason: "neoForge parchment block"
    });
  }
  return detections;
}

function camelCaseDependencyName(name: string): string {
  const parts = name.split(/[-_]/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return name;
  }
  const [first, ...rest] = parts;
  const head = first ?? "";
  return (
    head +
    rest
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")
  );
}

function lastGroupSegment(group: string): string {
  const segments = group.split(".").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? group;
}

function buildDependencyPropertyKeys(group: string, name: string): string[] {
  const camelName = camelCaseDependencyName(name);
  const groupSegment = lastGroupSegment(group);
  const camelGroupName = camelCaseDependencyName(`${groupSegment}_${name}`);
  const snakeName = name.replace(/-/g, "_");
  const snakeGroupSegment = groupSegment.replace(/-/g, "_");
  // Hyphenated artifact names (e.g. fabric-api) are declared in
  // gradle.properties as snake_case keys (fabric_api_version), so the base
  // enumeration must probe the snake_case transforms too — including for the
  // umbrella artifact itself, which never reaches the umbrella fallback below.
  const keys = [
    `${name}_version`,
    `${snakeName}_version`,
    `${camelName}Version`,
    `${groupSegment}_${name}_version`,
    `${snakeGroupSegment}_${snakeName}_version`,
    `${camelGroupName}Version`
  ];
  return dedupeKeys(keys);
}

// Umbrella properties (fabric_api_version / fabricApiVersion) declare the
// UMBRELLA package's version, not a submodule's. They are never adopted as a
// submodule version directly — the umbrella version differs from every
// submodule version (e.g. fabric-api 0.153.0+26.2 vs
// fabric-screen-handler-api-v1 2.0.5+...). They only locate the cached
// umbrella POM, which names the real per-submodule versions.
function buildUmbrellaPropertyKeys(group: string, name: string): string[] {
  const groupSegment = lastGroupSegment(group);
  if (groupSegment === name) {
    return [];
  }
  return dedupeKeys([
    `${groupSegment.replace(/-/g, "_")}_version`,
    `${camelCaseDependencyName(groupSegment)}Version`
  ]);
}

function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(key);
    }
  }
  return deduped;
}

function readPomDependencyVersion(
  pomContent: string,
  group: string,
  name: string
): string | undefined {
  const blocks = pomContent.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  for (const block of blocks) {
    const groupId = block.match(/<groupId>\s*([^<]+?)\s*<\/groupId>/)?.[1];
    const artifactId = block.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
    if (groupId !== group || artifactId !== name) {
      continue;
    }
    // A matching block without a literal <version> (e.g. a managed entry
    // relying on inheritance) must not end the scan — a later block for the
    // same artifact may carry the concrete version.
    const version = block.match(/<version>\s*([^<]+?)\s*<\/version>/)?.[1];
    if (version) {
      return version;
    }
  }
  return undefined;
}

// When modules-2 caches several versions of a submodule, the cached umbrella
// POM (modules-2/files-2.1/<group>/<umbrella>/<version>/<hash>/<umbrella>-<version>.pom)
// is the only local evidence of which one the declared umbrella version maps
// to. Adoption is fail-closed: no umbrella property, no readable POM, no
// matching <dependency> entry, or a POM version absent from the cached
// candidates all leave the resolution unresolved instead of guessing.
async function adoptSubmoduleVersionFromUmbrellaPom(args: {
  group: string;
  name: string;
  propsContent: string | undefined;
  candidates: string[];
  candidatesSeen: string[];
  attempts: string[];
}): Promise<DependencyVersionResolution | undefined> {
  const { group, name, propsContent, candidates, candidatesSeen, attempts } = args;
  const groupSegment = lastGroupSegment(group);
  const umbrellaKeys = buildUmbrellaPropertyKeys(group, name);
  if (umbrellaKeys.length === 0) {
    return undefined;
  }

  let umbrellaVersion: string | undefined;
  if (propsContent !== undefined) {
    for (const key of umbrellaKeys) {
      attempts.push(`umbrella-property:${key}`);
      const value = readPropertyValue(propsContent, key);
      if (value && isSafeMavenVersionToken(value)) {
        umbrellaVersion = value;
        break;
      }
    }
  }
  if (!umbrellaVersion) {
    return undefined;
  }

  const umbrellaDir = resolve(
    resolveGradleUserHome(),
    "caches",
    "modules-2",
    "files-2.1",
    group,
    groupSegment,
    umbrellaVersion
  );
  attempts.push(`umbrella-pom:${umbrellaDir}`);

  let hashDirs: string[] = [];
  try {
    hashDirs = await readdir(umbrellaDir);
  } catch {
    return undefined;
  }

  const pomFileName = `${groupSegment}-${umbrellaVersion}.pom`;
  for (const hashDir of hashDirs) {
    const pomPath = resolve(umbrellaDir, hashDir, pomFileName);
    let pomContent: string;
    try {
      pomContent = await readFile(pomPath, "utf8");
    } catch {
      continue;
    }
    const version = readPomDependencyVersion(pomContent, group, name);
    if (!version || !isSafeMavenVersionToken(version)) {
      continue;
    }
    if (!candidates.includes(version)) {
      attempts.push(`umbrella-pom:${pomPath}:names-uncached-version:${version}`);
      return undefined;
    }
    return {
      resolved: true,
      version,
      source: `umbrella-pom:${pomPath}`,
      candidatesSeen,
      attempts,
      submoduleVersionSource: "umbrella-pom"
    };
  }
  return undefined;
}

function readPropertyValue(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "m");
  const match = content.match(pattern);
  if (!match) {
    return undefined;
  }
  const value = match[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function compareSemverDescending(left: string, right: string): number {
  const leftParts = left.split(/[.+-]/);
  const rightParts = right.split(/[.+-]/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? "0";
    const rightPart = rightParts[index] ?? "0";
    const leftNum = /^\d+$/.test(leftPart) ? Number.parseInt(leftPart, 10) : Number.NaN;
    const rightNum = /^\d+$/.test(rightPart) ? Number.parseInt(rightPart, 10) : Number.NaN;
    if (!Number.isNaN(leftNum) && !Number.isNaN(rightNum)) {
      if (leftNum !== rightNum) {
        return rightNum - leftNum;
      }
      continue;
    }
    if (leftPart !== rightPart) {
      return rightPart.localeCompare(leftPart);
    }
  }
  return 0;
}

function isPathTraversalToken(token: string): boolean {
  return token.length === 0 || token.includes("/") || token.includes("\\") || token.includes("..") || token.includes("\0");
}

const SAFE_VERSION_TOKEN_RE = /^[A-Za-z0-9._+-]+$/;

export function isSafeMavenVersionToken(token: string): boolean {
  if (typeof token !== "string" || token.length === 0 || token.length > 200) {
    return false;
  }
  if (token.startsWith(".") || token.includes("..")) {
    return false;
  }
  return SAFE_VERSION_TOKEN_RE.test(token);
}

function resolveGradleUserHome(): string {
  const configured = process.env.GRADLE_USER_HOME?.trim();
  if (configured) {
    return configured;
  }
  return resolve(homedir(), ".gradle");
}

function detectLoadersFromContent(content: string): LoaderDetection[] {
  const detections: LoaderDetection[] = [];
  if (/\bid\s*(?:\(\s*)?["']net\.neoforged\.moddev["']\s*\)?/i.test(content)) {
    detections.push({
      loader: "neoforge",
      reason: "net.neoforged.moddev plugin"
    });
  }
  if (/\bid\s*(?:\(\s*)?["']net\.minecraftforge\.gradle["']\s*\)?/i.test(content)) {
    detections.push({
      loader: "forge",
      reason: "net.minecraftforge.gradle plugin"
    });
  }
  if (/\bid\s*(?:\(\s*)?["']org\.quiltmc\.loom["']\s*\)?/i.test(content)) {
    detections.push({
      loader: "quilt",
      reason: "org.quiltmc.loom plugin"
    });
  }
  if (/\bid\s*(?:\(\s*)?["']fabric-loom["']\s*\)?/i.test(content) || /\bid\s*(?:\(\s*)?["']dev\.architectury\.loom["']\s*\)?/i.test(content)) {
    detections.push({
      loader: "fabric",
      reason: "fabric/dev.architectury loom plugin"
    });
  }
  if (/\bminecraft\s*\{[\s\S]*?\baccessTransformer\b/i.test(content)) {
    detections.push({
      loader: "forge",
      reason: "minecraft { accessTransformer ... } block"
    });
  }
  if (/\bneoForge\s*\{[\s\S]*?\baccessTransformers\b/i.test(content)) {
    detections.push({
      loader: "neoforge",
      reason: "neoForge { accessTransformers ... } block"
    });
  }
  return detections;
}

export class WorkspaceMappingService {
  async detectCompileMapping(
    input: WorkspaceCompileMappingInput
  ): Promise<WorkspaceCompileMappingOutput> {
    const projectPath = input.projectPath?.trim();
    if (!projectPath) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "projectPath must be a non-empty string.",
        details: {
          projectPath: input.projectPath
        }
      });
    }

    const root = resolve(projectPath);
    const files = (await fastGlob.glob(["build.gradle", "build.gradle.kts", "**/build.gradle", "**/build.gradle.kts"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/.git/**", "**/.gradle/**", "**/build/**", "**/out/**", "**/node_modules/**"]
    })).sort((left, right) => left.localeCompare(right));

    const evidence = (await mapWithConcurrencyLimit(
      files,
      WORKSPACE_FILE_READ_CONCURRENCY,
      async (filePath): Promise<WorkspaceMappingEvidence[]> => {
        let content: string;
        try {
          content = await readFile(filePath, "utf8");
        } catch {
          return [];
        }
        return detectMappingsFromContent(content).map((detection) => ({
          filePath,
          mapping: detection.mapping,
          reason: detection.reason
        }));
      }
    )).flat();

    if (evidence.length === 0) {
      return {
        resolved: false,
        evidence,
        warnings: ["No compile-time mapping declaration was detected in build.gradle(.kts) files."]
      };
    }

    const mappingSet = new Set(evidence.map((entry) => entry.mapping));
    if (mappingSet.size > 1) {
      return {
        resolved: false,
        evidence,
        warnings: [
          `Multiple compile mappings were detected across the workspace: ${[...mappingSet].join(", ")}.`
        ]
      };
    }

    return {
      resolved: true,
      mappingApplied: evidence[0]!.mapping,
      evidence,
      warnings: []
    };
  }

  async detectProjectMinecraftVersion(projectPath: string): Promise<string | undefined> {
    const root = resolve(projectPath);
    const propsPath = resolve(root, "gradle.properties");
    let content: string;
    try {
      content = await readFile(propsPath, "utf8");
    } catch {
      return undefined;
    }

    // Search for common MC version property patterns
    const patterns = [
      /^minecraft_version\s*=\s*(.+)$/m,
      /^mc_version\s*=\s*(.+)$/m,
      /^minecraftVersion\s*=\s*(.+)$/m
    ];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
    return undefined;
  }

  async detectDependencyVersion(
    projectPath: string,
    group: string,
    name: string,
    opts?: DependencyVersionOptions
  ): Promise<DependencyVersionResolution> {
    if (isPathTraversalToken(group) || isPathTraversalToken(name)) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "Dependency group and name must not contain path traversal characters.",
        details: { group, name }
      });
    }

    const includeSnapshots = opts?.includeSnapshots === true;
    const attempts: string[] = [];
    const candidatesSeen: string[] = [];

    const root = resolve(projectPath);
    const propsPath = resolve(root, "gradle.properties");
    let propsContent: string | undefined;
    try {
      propsContent = await readFile(propsPath, "utf8");
    } catch {
      propsContent = undefined;
    }

    const keys = buildDependencyPropertyKeys(group, name);
    if (propsContent !== undefined) {
      for (const key of keys) {
        attempts.push(`gradle.properties:${key}`);
        const value = readPropertyValue(propsContent, key);
        if (value) {
          if (!isSafeMavenVersionToken(value)) {
            attempts.push(`gradle.properties:${key}:rejected-unsafe-version`);
            continue;
          }
          return {
            resolved: true,
            version: value,
            source: `gradle.properties:${key}`,
            candidatesSeen,
            attempts
          };
        }
      }
    } else {
      for (const key of keys) {
        attempts.push(`gradle.properties:${key}`);
      }
    }

    const modulesDir = resolve(
      resolveGradleUserHome(),
      "caches",
      "modules-2",
      "files-2.1",
      group,
      name
    );
    attempts.push(`modules-2:${modulesDir}`);

    let entries: string[] = [];
    try {
      entries = await readdir(modulesDir);
    } catch {
      return { resolved: false, candidatesSeen, attempts };
    }

    const filtered = entries.filter((entry) => {
      if (!isSafeMavenVersionToken(entry)) {
        return false;
      }
      if (includeSnapshots) {
        return true;
      }
      const lower = entry.toLowerCase();
      return !lower.endsWith("-snapshot") && !lower.endsWith("-dev");
    });

    const sorted = [...filtered].sort(compareSemverDescending);
    candidatesSeen.push(...sorted);

    if (sorted.length === 0) {
      return { resolved: false, candidatesSeen, attempts };
    }

    if (sorted.length > 1) {
      const pomAdoption = await adoptSubmoduleVersionFromUmbrellaPom({
        group,
        name,
        propsContent,
        candidates: sorted,
        candidatesSeen,
        attempts
      });
      if (pomAdoption) {
        return pomAdoption;
      }
      return { resolved: false, candidatesSeen, attempts };
    }

    const chosen = sorted[0];
    if (!chosen) {
      return { resolved: false, candidatesSeen, attempts };
    }
    return {
      resolved: true,
      version: chosen,
      source: `modules-2:${modulesDir}`,
      candidatesSeen,
      attempts
    };
  }

  async detectProjectLoader(projectPath: string): Promise<WorkspaceProjectLoaderOutput> {
    const root = resolve(projectPath);
    const buildFiles = (await fastGlob.glob(["build.gradle", "build.gradle.kts", "**/build.gradle", "**/build.gradle.kts"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/.git/**", "**/.gradle/**", "**/build/**", "**/out/**", "**/node_modules/**"]
    })).sort((left, right) => left.localeCompare(right));
    const descriptorFiles = (await fastGlob.glob([
      "fabric.mod.json",
      "quilt.mod.json",
      "META-INF/mods.toml",
      "META-INF/neoforge.mods.toml",
      "**/fabric.mod.json",
      "**/quilt.mod.json",
      "**/META-INF/mods.toml",
      "**/META-INF/neoforge.mods.toml"
    ], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/.git/**", "**/.gradle/**", "**/build/**", "**/out/**", "**/node_modules/**"]
    })).sort((left, right) => left.localeCompare(right));

    const evidence = (await mapWithConcurrencyLimit(
      buildFiles,
      WORKSPACE_FILE_READ_CONCURRENCY,
      async (filePath): Promise<WorkspaceLoaderEvidence[]> => {
        let content: string;
        try {
          content = await readFile(filePath, "utf8");
        } catch {
          return [];
        }
        return detectLoadersFromContent(content).map((detection) => ({
          filePath,
          loader: detection.loader,
          reason: detection.reason
        }));
      }
    )).flat();

    for (const descriptorPath of descriptorFiles) {
      const normalized = descriptorPath.replaceAll("\\", "/");
      if (normalized.endsWith("fabric.mod.json")) {
        evidence.push({
          filePath: descriptorPath,
          loader: "fabric",
          reason: "fabric.mod.json"
        });
      } else if (normalized.endsWith("quilt.mod.json")) {
        evidence.push({
          filePath: descriptorPath,
          loader: "quilt",
          reason: "quilt.mod.json"
        });
      } else if (normalized.endsWith("META-INF/neoforge.mods.toml")) {
        evidence.push({
          filePath: descriptorPath,
          loader: "neoforge",
          reason: "META-INF/neoforge.mods.toml"
        });
      } else if (normalized.endsWith("META-INF/mods.toml")) {
        evidence.push({
          filePath: descriptorPath,
          loader: "forge",
          reason: "META-INF/mods.toml"
        });
      }
    }

    if (evidence.length === 0) {
      return {
        resolved: false,
        evidence,
        warnings: ["No workspace loader declaration was detected from build.gradle(.kts) files or mod descriptors."]
      };
    }

    const loaderSet = new Set(
      evidence
        .map((entry) => entry.loader)
        .filter((loader): loader is Exclude<WorkspaceProjectLoader, "unknown"> => loader !== "unknown")
    );
    if (loaderSet.size !== 1) {
      return {
        resolved: false,
        evidence,
        warnings: [
          `Multiple or ambiguous workspace loaders were detected: ${[...loaderSet].join(", ") || "unknown"}.`
        ]
      };
    }

    return {
      resolved: true,
      loader: [...loaderSet][0],
      evidence,
      warnings: []
    };
  }
}
