import { isDeepStrictEqual } from "node:util";

import { createError, ERROR_CODES } from "../errors.js";

import {
  assertValidTypedNbtDocument,
  validateTypedNbtDocument,
  validateTypedNbtNode,
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

// Default repair guidance, mirroring the per-stage `nextAction` the NBT size-limit path
// already sets. `toHints()` reads only `details.nextAction`, so without one these
// rejections reach the client with nothing actionable. A caller-supplied `nextAction`
// still wins: the spread comes last.
const INVALID_PATCH_NEXT_ACTION =
  'The patch must be an RFC6902 array of {"op": "add"|"remove"|"replace"|"test", "path": ' +
  '"/json/pointer", "value": <typed-nbt-node>} objects. Paths address the typed document ' +
  '(for example "/root/value/<key>"), and an added or replaced value is a typed node, not a bare scalar.';
const UNSUPPORTED_FEATURE_NEXT_ACTION =
  "This operation is not expressible in Java NBT. Rewrite it in terms the format supports " +
  "(homogeneous lists, typed compound entries, decimal-string longs) and retry.";
const PATCH_CONFLICT_NEXT_ACTION =
  "The document did not hold what the patch expected at that path. Re-read the current " +
  "document with nbt-to-json and rebuild the patch against it.";

function invalidPatch(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.JSON_PATCH_INVALID,
    message,
    details: { nextAction: INVALID_PATCH_NEXT_ACTION, ...details }
  });
}

function unsupportedFeature(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.NBT_UNSUPPORTED_FEATURE,
    message,
    details: { nextAction: UNSUPPORTED_FEATURE_NEXT_ACTION, ...details }
  });
}

function patchConflict(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.JSON_PATCH_CONFLICT,
    message,
    details: { nextAction: PATCH_CONFLICT_NEXT_ACTION, ...details }
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

function isTypedNbtNode(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.type === "string";
}

function resolveParent(
  root: unknown,
  tokens: string[],
  opIndex: number,
  path: string
): { parent: unknown; key: string; enclosingNode: unknown; enclosingPointer: string } {
  if (tokens.length === 0) {
    patchConflict("Operation path does not reference a child location.", {
      opIndex,
      jsonPointer: path
    });
  }

  let cursor: unknown = root;
  let enclosingNode: unknown;
  let enclosingPointer = "";
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
      if (isTypedNbtNode(cursor)) {
        enclosingNode = cursor;
        enclosingPointer = pointer;
      }
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
    if (isTypedNbtNode(cursor)) {
      enclosingNode = cursor;
      enclosingPointer = pointer;
    }
  }

  return { parent: cursor, key: tokens[tokens.length - 1], enclosingNode, enclosingPointer };
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

function assertTypedNbtInvariant(
  subtree: { node: unknown; pointer: string } | { root: unknown },
  opIndex: number,
  path: string
): void {
  const validation =
    "root" in subtree
      ? validateTypedNbtDocument(subtree.root)
      : validateTypedNbtNode(subtree.node, subtree.pointer);
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
      let subtree: { node: unknown; pointer: string } | { root: unknown } = { root: working };
      if (tokens.length === 0) {
        working = nextValue;
        subtree = { root: working };
      } else {
        const { parent, key, enclosingNode, enclosingPointer } = resolveParent(
          working,
          tokens,
          i,
          operation.path
        );
        if (Array.isArray(parent)) {
          const index = parseArrayIndex(key, parent.length, {
            allowAppend: true,
            opIndex: i,
            path: operation.path
          });
          parent.splice(index, 0, nextValue);
        } else if (isRecord(parent)) {
          Object.defineProperty(parent, key, {
            value: nextValue,
            enumerable: true,
            writable: true,
            configurable: true
          });
        } else {
          patchConflict("Add target parent is not a container.", {
            opIndex: i,
            jsonPointer: operation.path
          });
        }
        subtree =
          enclosingNode === undefined
            ? { root: working }
            : { node: enclosingNode, pointer: enclosingPointer };
      }

      changed = true;
      assertTypedNbtInvariant(subtree, i, operation.path);
      continue;
    }

    if (operation.op === "remove") {
      if (tokens.length === 0) {
        patchConflict("Cannot remove the typed NBT document root.", {
          opIndex: i,
          jsonPointer: operation.path
        });
      }

      const { parent, key, enclosingNode, enclosingPointer } = resolveParent(
        working,
        tokens,
        i,
        operation.path
      );
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
      assertTypedNbtInvariant(
        enclosingNode === undefined
          ? { root: working }
          : { node: enclosingNode, pointer: enclosingPointer },
        i,
        operation.path
      );
      continue;
    }

    if (operation.op === "replace") {
      const nextValue = structuredClone(operation.value);
      let subtree: { node: unknown; pointer: string } | { root: unknown } = { root: working };
      if (tokens.length === 0) {
        working = nextValue;
        subtree = { root: working };
      } else {
        const { parent, key, enclosingNode, enclosingPointer } = resolveParent(
          working,
          tokens,
          i,
          operation.path
        );
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
          Object.defineProperty(parent, key, {
            value: nextValue,
            enumerable: true,
            writable: true,
            configurable: true
          });
        } else {
          patchConflict("Replace target parent is not a container.", {
            opIndex: i,
            jsonPointer: operation.path
          });
        }
        subtree =
          enclosingNode === undefined
            ? { root: working }
            : { node: enclosingNode, pointer: enclosingPointer };
      }

      changed = true;
      assertTypedNbtInvariant(subtree, i, operation.path);
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
