import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { normalizePathForHost } from "./path-converter.js";

function normalizeOptionalHostPath(value: string | undefined, field: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePathForHost(trimmed, undefined, field);
  return isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);
}

export function normalizeOptionalProjectPath(projectPath: string | undefined): string | undefined {
  return normalizeOptionalHostPath(projectPath, "projectPath");
}

export function normalizeOptionalGradleUserHomePath(gradleUserHome: string | undefined): string | undefined {
  return normalizeOptionalHostPath(gradleUserHome, "gradleUserHome");
}

export function resolveGradleUserHomePath(gradleUserHome?: string): string {
  return (
    normalizeOptionalGradleUserHomePath(gradleUserHome) ??
    normalizeOptionalHostPath(process.env.GRADLE_USER_HOME, "GRADLE_USER_HOME") ??
    resolvePath(homedir(), ".gradle")
  );
}

type GradleCacheSearchInput =
  | string
  | {
      projectPath?: string;
      gradleUserHome?: string;
    }
  | undefined;

function normalizeGradleCacheSearchInput(input: GradleCacheSearchInput): {
  projectPath?: string;
  gradleUserHome?: string;
} {
  if (typeof input === "string" || input === undefined) {
    return {
      projectPath: normalizeOptionalProjectPath(input)
    };
  }
  const gradleUserHome = normalizeOptionalGradleUserHomePath(input.gradleUserHome);
  return {
    projectPath: normalizeOptionalProjectPath(input.projectPath),
    gradleUserHome
  };
}

export function buildVersionSourceSearchRoots(input: GradleCacheSearchInput): string[] {
  const { projectPath, gradleUserHome } = normalizeGradleCacheSearchInput(input);
  const roots = new Set<string>();
  if (projectPath) {
    roots.add(resolvePath(projectPath, ".gradle", "loom-cache"));
    roots.add(resolvePath(projectPath, ".gradle-user", "caches", "fabric-loom"));
    roots.add(resolvePath(projectPath, ".gradle", "caches", "fabric-loom"));
    const projectParent = dirname(projectPath);
    roots.add(resolvePath(projectParent, ".gradle-user-home", "loom-cache"));
    roots.add(resolvePath(projectParent, ".gradle-user-home", "caches", "fabric-loom"));
  }
  const homeGradle = resolveGradleUserHomePath(gradleUserHome);
  roots.add(resolvePath(homeGradle, "loom-cache"));
  roots.add(resolvePath(homeGradle, "caches", "fabric-loom"));
  return [...roots];
}

export function buildLoaderRuntimeSearchRoots(input: GradleCacheSearchInput): string[] {
  const { projectPath, gradleUserHome } = normalizeGradleCacheSearchInput(input);
  const roots = new Set<string>();
  if (projectPath) {
    roots.add(resolvePath(projectPath, "build"));
    roots.add(resolvePath(projectPath, ".gradle"));
  }
  const homeGradle = resolveGradleUserHomePath(gradleUserHome);
  roots.add(resolvePath(homeGradle, "caches", "forge_gradle"));
  roots.add(resolvePath(homeGradle, "caches", "neogradle"));
  roots.add(resolvePath(homeGradle, "caches", "neoformruntime"));
  roots.add(resolvePath(homeGradle, "caches", "moddev"));
  return [...roots];
}
