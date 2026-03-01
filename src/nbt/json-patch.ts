import { isDeepStrictEqual } from "node:util";

import { createError, ERROR_CODES } from "../errors.js";

import {
  assertValidTypedNbtDocument,
  validateTypedNbtDocument,
  type TypedNbtDocument
} from "./typed-json.js";
import type { ApplyJsonPatchResult, JsonPatchOperation } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function invalidPatch(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.JSON_PATCH_INVALID,
    message,
    details
  });
}

function unsupportedFeature(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.NBT_UNSUPPORTED_FEATURE,
    message,
    details
  });
}

function patchConflict(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.JSON_PATCH_CONFLICT,
    message,
    details
  });
}

function parsePatchOperations(patch: unknown): JsonPatchOperation[] {
  if (!Array.isArray(patch)) {
    invalidPatch("JSON Patch must be an array.");
  }

  const normalized: JsonPatchOperation[] = [];

  for (let i = 0; i < patch.length; i += 1) {
    const rawOperation = patch[i];
    if (!isRecord(rawOperation)) {
      invalidPatch("JSON Patch operation must be an object.", { opIndex: i });
    }
    if (typeof rawOperation.op !== "string") {
      invalidPatch('JSON Patch operation requires string field "op".', { opIndex: i });
    }
    if (typeof rawOperation.path !== "string") {
      invalidPatch('JSON Patch operation requires string field "path".', { opIndex: i });
    }

    if (rawOperation.op === "move" || rawOperation.op === "copy") {
      unsupportedFeature(`JSON Patch operation "${rawOperation.op}" is not supported in v1.`, {
        opIndex: i,
        op: rawOperation.op
      });
    }

    if (
      rawOperation.op !== "add" &&
      rawOperation.op !== "remove" &&
      rawOperation.op !== "replace" &&
      rawOperation.op !== "test"
    ) {
      invalidPatch(`Unsupported JSON Patch operation "${rawOperation.op}".`, {
        opIndex: i,
        op: rawOperation.op
      });
    }

    if (
      (rawOperation.op === "add" ||
        rawOperation.op === "replace" ||
        rawOperation.op === "test") &&
      !("value" in rawOperation)
    ) {
      invalidPatch(`JSON Patch operation "${rawOperation.op}" requires "value".`, {
        opIndex: i
      });
    }

    normalized.push({
      op: rawOperation.op,
      path: rawOperation.path,
      from: typeof rawOperation.from === "string" ? rawOperation.from : undefined,
      value: rawOperation.value
    });
  }

  return normalized;
}

function decodePointerToken(path: string, token: string, opIndex: number): string {
  if (/~(?:[^01]|$)/.test(token)) {
    invalidPatch("Invalid JSON Pointer escape sequence.", {
      opIndex,
      path
    });
  }
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function parsePointer(path: string, opIndex: number): string[] {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    invalidPatch('JSON Pointer path must be empty or start with "/".', {
      opIndex,
      path
    });
  }

  return path
    .split("/")
    .slice(1)
    .map((token) => decodePointerToken(path, token, opIndex));
}

function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function parseArrayIndex(
  token: string,
  length: number,
  options: { allowAppend: boolean; opIndex: number; path: string }
): number {
  if (token === "-") {
    if (options.allowAppend) {
      return length;
    }
    patchConflict('"-" is only allowed for add on arrays.', {
      opIndex: options.opIndex,
      jsonPointer: options.path
    });
  }

  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    patchConflict("Invalid array index in JSON Pointer.", {
      opIndex: options.opIndex,
      jsonPointer: options.path
    });
  }

  const index = Number.parseInt(token, 10);
  if (options.allowAppend) {
    if (index > length) {
      patchConflict("Array add index is out of bounds.", {
        opIndex: options.opIndex,
        jsonPointer: options.path
      });
    }
  } else if (index >= length) {
    patchConflict("Array index is out of bounds.", {
      opIndex: options.opIndex,
      jsonPointer: options.path
    });
  }

  return index;
}

function resolveParent(
  root: unknown,
  tokens: string[],
  opIndex: number,
  path: string
): { parent: unknown; key: string } {
  if (tokens.length === 0) {
    patchConflict("Operation path does not reference a child location.", {
      opIndex,
      jsonPointer: path
    });
  }

  let cursor: unknown = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    const pointer = `/${tokens.slice(0, i + 1).join("/")}`;

    if (Array.isArray(cursor)) {
      const index = parseArrayIndex(token, cursor.length, {
        allowAppend: false,
        opIndex,
        path: pointer
      });
      cursor = cursor[index];
      continue;
    }

    if (!isRecord(cursor)) {
      patchConflict("JSON Pointer traversed into a non-container value.", {
        opIndex,
        jsonPointer: pointer
      });
    }

    if (!hasOwn(cursor, token)) {
      patchConflict("JSON Pointer path does not exist.", {
        opIndex,
        jsonPointer: pointer
      });
    }

    cursor = cursor[token];
  }

  return { parent: cursor, key: tokens[tokens.length - 1] };
}

function readValueAtPath(root: unknown, tokens: string[], opIndex: number, path: string): unknown {
  if (tokens.length === 0) {
    return root;
  }

  let cursor: unknown = root;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const pointer = `/${tokens.slice(0, i + 1).join("/")}`;

    if (Array.isArray(cursor)) {
      const index = parseArrayIndex(token, cursor.length, {
        allowAppend: false,
        opIndex,
        path: pointer
      });
      cursor = cursor[index];
      continue;
    }

    if (!isRecord(cursor)) {
      patchConflict("JSON Pointer traversed into a non-container value.", {
        opIndex,
        jsonPointer: pointer
      });
    }

    if (!hasOwn(cursor, token)) {
      patchConflict("JSON Pointer path does not exist.", {
        opIndex,
        jsonPointer: pointer
      });
    }

    cursor = cursor[token];
  }

  return cursor;
}

function assertTypedNbtInvariant(root: unknown, opIndex: number, path: string): void {
  const validation = validateTypedNbtDocument(root);
  if (!validation.ok) {
    patchConflict("JSON Patch operation produced invalid typed NBT JSON.", {
      opIndex,
      jsonPointer: validation.issue.jsonPointer,
      expectedType: validation.issue.expectedType,
      actualType: validation.issue.actualType,
      path
    });
  }
}

export function applyJsonPatch(document: TypedNbtDocument, patch: unknown): ApplyJsonPatchResult {
  assertValidTypedNbtDocument(document);
  const operations = parsePatchOperations(patch);

  let working: unknown = structuredClone(document);
  let testOps = 0;
  let changed = false;

  for (let i = 0; i < operations.length; i += 1) {
    const operation = operations[i];
    const tokens = parsePointer(operation.path, i);

    if (operation.op === "test") {
      const actual = readValueAtPath(working, tokens, i, operation.path);
      testOps += 1;
      if (!isDeepStrictEqual(actual, operation.value)) {
        patchConflict("JSON Patch test operation failed.", {
          opIndex: i,
          jsonPointer: operation.path,
          expectedType: typeof operation.value,
          actualType: typeof actual
        });
      }
      continue;
    }

    if (operation.op === "add") {
      const nextValue = structuredClone(operation.value);
      if (tokens.length === 0) {
        working = nextValue;
      } else {
        const { parent, key } = resolveParent(working, tokens, i, operation.path);
        if (Array.isArray(parent)) {
          const index = parseArrayIndex(key, parent.length, {
            allowAppend: true,
            opIndex: i,
            path: operation.path
          });
          parent.splice(index, 0, nextValue);
        } else if (isRecord(parent)) {
          parent[key] = nextValue;
        } else {
          patchConflict("Add target parent is not a container.", {
            opIndex: i,
            jsonPointer: operation.path
          });
        }
      }

      changed = true;
      assertTypedNbtInvariant(working, i, operation.path);
      continue;
    }

    if (operation.op === "remove") {
      if (tokens.length === 0) {
        patchConflict("Cannot remove the typed NBT document root.", {
          opIndex: i,
          jsonPointer: operation.path
        });
      }

      const { parent, key } = resolveParent(working, tokens, i, operation.path);
      if (Array.isArray(parent)) {
        const index = parseArrayIndex(key, parent.length, {
          allowAppend: false,
          opIndex: i,
          path: operation.path
        });
        parent.splice(index, 1);
      } else if (isRecord(parent)) {
        if (!hasOwn(parent, key)) {
          patchConflict("Remove target path does not exist.", {
            opIndex: i,
            jsonPointer: operation.path
          });
        }
        delete parent[key];
      } else {
        patchConflict("Remove target parent is not a container.", {
          opIndex: i,
          jsonPointer: operation.path
        });
      }

      changed = true;
      assertTypedNbtInvariant(working, i, operation.path);
      continue;
    }

    if (operation.op === "replace") {
      const nextValue = structuredClone(operation.value);
      if (tokens.length === 0) {
        working = nextValue;
      } else {
        const { parent, key } = resolveParent(working, tokens, i, operation.path);
        if (Array.isArray(parent)) {
          const index = parseArrayIndex(key, parent.length, {
            allowAppend: false,
            opIndex: i,
            path: operation.path
          });
          parent[index] = nextValue;
        } else if (isRecord(parent)) {
          if (!hasOwn(parent, key)) {
            patchConflict("Replace target path does not exist.", {
              opIndex: i,
              jsonPointer: operation.path
            });
          }
          parent[key] = nextValue;
        } else {
          patchConflict("Replace target parent is not a container.", {
            opIndex: i,
            jsonPointer: operation.path
          });
        }
      }

      changed = true;
      assertTypedNbtInvariant(working, i, operation.path);
      continue;
    }
  }

  assertValidTypedNbtDocument(working);
  return {
    typedJson: working,
    meta: {
      appliedOps: operations.length,
      testOps,
      changed
    }
  };
}
