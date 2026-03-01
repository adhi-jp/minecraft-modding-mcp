import { createError, ERROR_CODES } from "../errors.js";

import type {
  NbtListElementType,
  NbtNodeType,
  NbtTagName,
  TypedNbtDocument,
  TypedNbtValidationIssue
} from "./types.js";

const NODE_TYPES: NbtNodeType[] = [
  "byte",
  "short",
  "int",
  "long",
  "float",
  "double",
  "byteArray",
  "string",
  "list",
  "compound",
  "intArray",
  "longArray"
];

const LIST_ELEMENT_TYPES: NbtListElementType[] = ["end", ...NODE_TYPES];

const NODE_TYPE_SET = new Set<string>(NODE_TYPES);
const LIST_ELEMENT_TYPE_SET = new Set<string>(LIST_ELEMENT_TYPES);

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;

type ValidationResult =
  | { ok: true }
  | { ok: false; issue: TypedNbtValidationIssue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function fail(
  jsonPointer: string,
  expectedType: string,
  actualValue: unknown
): ValidationResult {
  return {
    ok: false,
    issue: {
      jsonPointer,
      expectedType,
      actualType: describeType(actualValue)
    }
  };
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function validateIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  pointer: string,
  expectedType: string
): ValidationResult {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fail(pointer, expectedType, value);
  }
  return { ok: true };
}

function validateLongString(value: unknown, pointer: string): ValidationResult {
  if (typeof value !== "string") {
    return fail(pointer, "int64-decimal-string", value);
  }
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) {
    return fail(pointer, "int64-decimal-string", value);
  }

  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return fail(pointer, "int64-decimal-string", value);
  }

  if (parsed < INT64_MIN || parsed > INT64_MAX) {
    return fail(pointer, "int64-decimal-string", value);
  }

  return { ok: true };
}

function validateLongStringArray(value: unknown, pointer: string): ValidationResult {
  if (!Array.isArray(value)) {
    return fail(pointer, "int64-decimal-string-array", value);
  }
  for (let i = 0; i < value.length; i += 1) {
    const result = validateLongString(value[i], `${pointer}/${i}`);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

function validateNumericArray(
  value: unknown,
  pointer: string,
  expectedType: string,
  min: number,
  max: number
): ValidationResult {
  if (!Array.isArray(value)) {
    return fail(pointer, expectedType, value);
  }
  for (let i = 0; i < value.length; i += 1) {
    const result = validateIntegerInRange(value[i], min, max, `${pointer}/${i}`, expectedType);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true };
}

function validateNode(value: unknown, pointer: string): ValidationResult {
  if (!isRecord(value)) {
    return fail(pointer, "nbt-node", value);
  }

  if (!("type" in value)) {
    return fail(`${pointer}/type`, "nbt-node-type", undefined);
  }

  const nodeTypeRaw = value.type;
  if (typeof nodeTypeRaw !== "string" || !NODE_TYPE_SET.has(nodeTypeRaw)) {
    return fail(`${pointer}/type`, "nbt-node-type", nodeTypeRaw);
  }

  const nodeType = nodeTypeRaw as NbtNodeType;
  const node = value as Record<string, unknown>;

  switch (nodeType) {
    case "byte":
      return validateIntegerInRange(node.value, -128, 127, `${pointer}/value`, "int8");
    case "short":
      return validateIntegerInRange(node.value, -32768, 32767, `${pointer}/value`, "int16");
    case "int":
      return validateIntegerInRange(
        node.value,
        -2147483648,
        2147483647,
        `${pointer}/value`,
        "int32"
      );
    case "long":
      return validateLongString(node.value, `${pointer}/value`);
    case "float":
    case "double":
      if (typeof node.value !== "number" || !Number.isFinite(node.value)) {
        return fail(`${pointer}/value`, "finite-number", node.value);
      }
      return { ok: true };
    case "string":
      if (typeof node.value !== "string") {
        return fail(`${pointer}/value`, "string", node.value);
      }
      return { ok: true };
    case "byteArray":
      return validateNumericArray(node.value, `${pointer}/value`, "int8-array", -128, 127);
    case "intArray":
      return validateNumericArray(
        node.value,
        `${pointer}/value`,
        "int32-array",
        -2147483648,
        2147483647
      );
    case "longArray":
      return validateLongStringArray(node.value, `${pointer}/value`);
    case "list": {
      const elementType = node.elementType;
      if (typeof elementType !== "string" || !LIST_ELEMENT_TYPE_SET.has(elementType)) {
        return fail(`${pointer}/elementType`, "nbt-list-element-type", elementType);
      }

      const listValue = node.value;
      if (!Array.isArray(listValue)) {
        return fail(`${pointer}/value`, "nbt-node-array", listValue);
      }

      if (elementType === "end" && listValue.length > 0) {
        return fail(`${pointer}/value`, "empty-array-for-end-list", listValue);
      }

      for (let i = 0; i < listValue.length; i += 1) {
        const childPointer = `${pointer}/value/${i}`;
        const childValidation = validateNode(listValue[i], childPointer);
        if (!childValidation.ok) {
          return childValidation;
        }
        if (!isRecord(listValue[i])) {
          return fail(childPointer, "nbt-node", listValue[i]);
        }
        const childType = listValue[i].type;
        if (typeof childType !== "string" || childType !== elementType) {
          return fail(`${childPointer}/type`, elementType, childType);
        }
      }
      return { ok: true };
    }
    case "compound": {
      const compoundValue = node.value;
      if (!isRecord(compoundValue)) {
        return fail(`${pointer}/value`, "object", compoundValue);
      }

      for (const [key, childValue] of Object.entries(compoundValue)) {
        const childPointer = `${pointer}/value/${escapePointerToken(key)}`;
        const childValidation = validateNode(childValue, childPointer);
        if (!childValidation.ok) {
          return childValidation;
        }
      }
      return { ok: true };
    }
    default:
      return fail(`${pointer}/type`, "nbt-node-type", nodeType);
  }
}

export function validateTypedNbtDocument(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return fail("", "typed-nbt-document", value);
  }

  if (typeof value.rootName !== "string") {
    return fail("/rootName", "string", value.rootName);
  }

  if (!("root" in value)) {
    return fail("/root", "nbt-node", undefined);
  }

  return validateNode(value.root, "/root");
}

export function assertValidTypedNbtDocument(value: unknown): asserts value is TypedNbtDocument {
  const validation = validateTypedNbtDocument(value);
  if (!validation.ok) {
    throw createError({
      code: ERROR_CODES.NBT_INVALID_TYPED_JSON,
      message: "Invalid typed NBT JSON document.",
      details: { ...validation.issue }
    });
  }
}

export type { TypedNbtDocument, TypedNbtValidationIssue } from "./types.js";
