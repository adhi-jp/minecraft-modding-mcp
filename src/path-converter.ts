import { release } from "node:os";

import { createError, ERROR_CODES } from "./errors.js";

export interface PathRuntimeInfo {
  platform: NodeJS.Platform;
  isWsl: boolean;
  wslDistro?: string;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const MALFORMED_WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?![\\/])/;
const WSL_MOUNT_PATH = /^\/mnt\/[a-z](?:\/|$)/i;
const UNC_WSL_PATH = /^(?:\\\\wsl\$\\|\/\/wsl\$\/)/i;

function normalizeToUnixSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeToWindowsSlashes(value: string): string {
  return value.replace(/\//g, "\\");
}

function parseUncWslPath(pathValue: string): { distro: string; innerPath: string } | undefined {
  const normalized = normalizeToUnixSlashes(pathValue);
  if (!normalized.toLowerCase().startsWith("//wsl$/")) {
    return undefined;
  }

  const remainder = normalized.slice("//wsl$/".length).replace(/^\/+/, "");
  const slashIndex = remainder.indexOf("/");
  if (slashIndex < 0) {
    return {
      distro: remainder,
      innerPath: ""
    };
  }

  return {
    distro: remainder.slice(0, slashIndex),
    innerPath: remainder.slice(slashIndex + 1)
  };
}

export function detectPathRuntime(): PathRuntimeInfo {
  const platform = process.platform;
  const osRelease = release().toLowerCase();
  const isWsl =
    platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      Boolean(process.env.WSL_INTEROP) ||
      osRelease.includes("microsoft"));

  return {
    platform,
    isWsl,
    wslDistro: process.env.WSL_DISTRO_NAME
  };
}

export function isWindowsDrivePath(pathValue: string): boolean {
  return WINDOWS_DRIVE_PATH.test(pathValue);
}

export function isWslMountPath(pathValue: string): boolean {
  return WSL_MOUNT_PATH.test(pathValue);
}

export function isUncWslPath(pathValue: string): boolean {
  return UNC_WSL_PATH.test(pathValue);
}

export function validatePathFormat(pathValue: string, runtimeInfo?: PathRuntimeInfo): string | undefined {
  const runtime = runtimeInfo ?? detectPathRuntime();
  const trimmed = pathValue.trim();

  if (!trimmed) {
    return "Path is required.";
  }

  if (trimmed.includes("\0")) {
    return "Path contains an invalid null character.";
  }

  if (MALFORMED_WINDOWS_DRIVE_PATH.test(trimmed)) {
    return 'Windows drive paths must include a separator after the drive (example: "C:\\\\path").';
  }

  if (isUncWslPath(trimmed)) {
    const parsed = parseUncWslPath(trimmed);
    if (!parsed?.distro) {
      return 'UNC WSL paths must include a distro segment (example: "\\\\\\\\wsl$\\\\Ubuntu\\\\path").';
    }
  }

  const usesWindowsStyle = isWindowsDrivePath(trimmed) || isUncWslPath(trimmed);
  if (usesWindowsStyle && runtime.platform !== "win32" && !runtime.isWsl) {
    return "Windows-style paths are not supported on this host.";
  }

  return undefined;
}

function throwInvalidPath(
  pathValue: string,
  reason: string,
  runtime: PathRuntimeInfo,
  field?: string
): never {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: reason,
    details: {
      field: field ?? "path",
      path: pathValue,
      platform: runtime.platform,
      isWsl: runtime.isWsl
    }
  });
}

function toWslPath(pathValue: string, runtime: PathRuntimeInfo, field?: string): string {
  if (isWindowsDrivePath(pathValue)) {
    const normalized = normalizeToUnixSlashes(pathValue);
    const match = normalized.match(/^([A-Za-z]):(?:\/(.*))?$/);
    if (!match?.[1]) {
      throwInvalidPath(pathValue, "Failed to parse Windows drive path.", runtime, field);
    }

    const drive = match[1].toLowerCase();
    const rest = (match[2] ?? "").replace(/^\/+/, "");
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }

  const parsed = parseUncWslPath(pathValue);
  if (parsed) {
    const rest = parsed.innerPath.replace(/^\/+/, "");
    return rest ? `/${rest}` : "/";
  }

  return pathValue;
}

function toWindowsPath(pathValue: string, runtime: PathRuntimeInfo, field?: string): string {
  if (isWslMountPath(pathValue)) {
    const normalized = normalizeToUnixSlashes(pathValue);
    const match = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
    if (!match?.[1]) {
      throwInvalidPath(pathValue, "Failed to parse WSL mount path.", runtime, field);
    }

    const drive = match[1].toUpperCase();
    const rest = (match[2] ?? "").replace(/^\/+/, "").replace(/\//g, "\\");
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  if (pathValue.startsWith("/")) {
    const distro = runtime.wslDistro?.trim();
    if (!distro) {
      throwInvalidPath(
        pathValue,
        "Cannot convert Unix path to Windows path without WSL distro name.",
        runtime,
        field
      );
    }
    return `\\\\wsl$\\${distro}${pathValue.replace(/\//g, "\\")}`;
  }

  return normalizeToWindowsSlashes(pathValue);
}

export function normalizePathForHost(
  pathValue: string,
  runtimeInfo?: PathRuntimeInfo,
  field?: string
): string {
  const runtime = runtimeInfo ?? detectPathRuntime();
  const validationError = validatePathFormat(pathValue, runtime);
  if (validationError) {
    throwInvalidPath(pathValue, validationError, runtime, field);
  }

  const trimmed = pathValue.trim();
  if (runtime.isWsl) {
    if (isWindowsDrivePath(trimmed) || isUncWslPath(trimmed)) {
      return toWslPath(trimmed, runtime, field);
    }
    return trimmed;
  }

  if (runtime.platform === "win32") {
    if (isWindowsDrivePath(trimmed) || isUncWslPath(trimmed)) {
      return normalizeToWindowsSlashes(trimmed);
    }
    if (isWslMountPath(trimmed) || trimmed.startsWith("/")) {
      return toWindowsPath(trimmed, runtime, field);
    }
    return trimmed;
  }

  return trimmed;
}

export function normalizeOptionalPathForHost(
  pathValue: string | undefined,
  runtimeInfo?: PathRuntimeInfo,
  field?: string
): string | undefined {
  if (!pathValue) {
    return undefined;
  }
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizePathForHost(trimmed, runtimeInfo, field);
}
