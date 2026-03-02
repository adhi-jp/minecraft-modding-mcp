import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fastGlob from "fast-glob";

import { createError, ERROR_CODES } from "./errors.js";
import type { SourceMapping } from "./types.js";

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

type MappingDetection = {
  mapping: SourceMapping;
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
    const files = fastGlob.sync(["build.gradle", "build.gradle.kts", "**/build.gradle", "**/build.gradle.kts"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/.git/**", "**/.gradle/**", "**/build/**", "**/out/**", "**/node_modules/**"]
    });

    const evidence: WorkspaceMappingEvidence[] = [];
    for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const detections = detectMappingsFromContent(content);
      for (const detection of detections) {
        evidence.push({
          filePath,
          mapping: detection.mapping,
          reason: detection.reason
        });
      }
    }

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
}
