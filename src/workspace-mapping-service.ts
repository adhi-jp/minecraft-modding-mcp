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
  const keys = [
    `${name}_version`,
    `${camelName}Version`,
    `${groupSegment}_${name}_version`,
    `${camelGroupName}Version`
  ];
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
      if (entry.startsWith(".")) {
        return false;
      }
      if (includeSnapshots) {
        return true;
      }
      const lower = entry.toLowerCase();
      return !lower.endsWith("-snapshot") && !lower.endsWith("-dev");
    });

    candidatesSeen.push(...filtered);

    if (filtered.length === 0) {
      return { resolved: false, candidatesSeen, attempts };
    }

    const sorted = [...filtered].sort(compareSemverDescending);
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
