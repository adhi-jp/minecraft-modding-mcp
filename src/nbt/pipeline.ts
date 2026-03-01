import { gunzipSync, gzipSync } from "node:zlib";

import { createError, ERROR_CODES } from "../errors.js";

import { decodeJavaNbt, encodeJavaNbt } from "./java-nbt-codec.js";
import { applyJsonPatch } from "./json-patch.js";
import { assertValidTypedNbtDocument, type TypedNbtDocument } from "./typed-json.js";
import type { ApplyJsonPatchResult } from "./types.js";

export type DecodeCompression = "none" | "gzip" | "auto";
export type EncodeCompression = "none" | "gzip";
export interface NbtLimits {
  maxInputBytes: number;
  maxInflatedBytes: number;
  maxResponseBytes: number;
}

type NbtLimitStage = "decode-input" | "inflate" | "decode-output" | "encode-output" | "patch-output";
type NbtLimitField = "nbtBase64" | "typedJson" | "result";

export const DEFAULT_NBT_LIMITS: NbtLimits = {
  maxInputBytes: 4 * 1024 * 1024,
  maxInflatedBytes: 16 * 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024
};

export interface NbtToJsonInput {
  nbtBase64: string;
  compression?: DecodeCompression;
}

export interface JsonToNbtInput {
  typedJson: unknown;
  compression?: EncodeCompression;
}

export interface ApplyPatchInput {
  typedJson: unknown;
  patch: unknown;
}

export interface NbtToJsonOutput {
  typedJson: TypedNbtDocument;
  meta: {
    compressionDetected: "none" | "gzip";
    inputBytes: number;
  };
}

export interface JsonToNbtOutput {
  nbtBase64: string;
  meta: {
    outputBytes: number;
    compressionApplied: EncodeCompression;
  };
}

function invalidInput(message: string, details?: Record<string, unknown>): never {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message,
    details
  });
}

function limitExceeded(
  stage: NbtLimitStage,
  field: NbtLimitField,
  actual: number,
  limit: number
): never {
  let message = "NBT payload exceeds configured size limit.";
  let nextAction = "Reduce payload size or increase NBT limits.";
  if (stage === "decode-input") {
    message = "Decoded NBT payload exceeds max input bytes.";
    nextAction = "Use smaller nbtBase64 input or increase MCP_MAX_NBT_INPUT_BYTES.";
  } else if (stage === "inflate") {
    message = "Inflated gzip NBT payload exceeds max inflated bytes.";
    nextAction = "Use smaller compressed payload or increase MCP_MAX_NBT_INFLATED_BYTES.";
  } else if (stage === "decode-output" || stage === "patch-output") {
    message = "Typed NBT JSON response exceeds max response bytes.";
    nextAction = "Reduce typedJson size or increase MCP_MAX_NBT_RESPONSE_BYTES.";
  } else if (stage === "encode-output") {
    message = "NBT base64 response exceeds max response bytes.";
    nextAction = "Reduce typedJson size or increase MCP_MAX_NBT_RESPONSE_BYTES.";
  }

  throw createError({
    code: ERROR_CODES.LIMIT_EXCEEDED,
    message,
    details: {
      stage,
      field,
      actual,
      limit,
      nextAction
    }
  });
}

function assertByteLimit(stage: NbtLimitStage, field: NbtLimitField, actual: number, limit: number): void {
  if (actual > limit) {
    limitExceeded(stage, field, actual, limit);
  }
}

function jsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function estimatedDecodedBase64Bytes(normalizedBase64: string): number {
  const paddingBytes = normalizedBase64.endsWith("==") ? 2 : normalizedBase64.endsWith("=") ? 1 : 0;
  return (normalizedBase64.length / 4) * 3 - paddingBytes;
}

function isInflateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) {
    return false;
  }
  const maybeError = error as { code?: unknown; message?: unknown };
  if (maybeError.code === "ERR_BUFFER_TOO_LARGE") {
    return true;
  }
  if (typeof maybeError.message !== "string") {
    return false;
  }
  const normalizedMessage = maybeError.message.toLowerCase();
  return normalizedMessage.includes("maxoutputlength") || normalizedMessage.includes("cannot create a buffer larger");
}

function inflateParseFailed(error: unknown): never {
  throw createError({
    code: ERROR_CODES.NBT_PARSE_FAILED,
    message: "Failed to inflate gzip NBT payload.",
    details: {
      reason: error instanceof Error ? error.message : String(error),
      nextAction: "Provide valid gzip-compressed NBT data or set compression to none for uncompressed payloads."
    }
  });
}

function parseDecodeCompression(value: unknown): DecodeCompression {
  if (value === undefined) {
    return "auto";
  }
  if (value === "none" || value === "gzip" || value === "auto") {
    return value;
  }
  invalidInput('Field "compression" must be one of none|gzip|auto.');
}

function parseEncodeCompression(value: unknown): EncodeCompression {
  if (value === undefined) {
    return "none";
  }
  if (value === "none" || value === "gzip") {
    return value;
  }
  invalidInput('Field "compression" must be one of none|gzip.');
}

function decodeBase64Nbt(value: unknown, limits: NbtLimits): Buffer {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidInput('Field "nbtBase64" must be a non-empty base64 string.');
  }

  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    invalidInput('Field "nbtBase64" is not valid base64.');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    invalidInput('Field "nbtBase64" is not valid base64.');
  }

  const estimatedDecodedBytes = estimatedDecodedBase64Bytes(normalized);
  assertByteLimit("decode-input", "nbtBase64", estimatedDecodedBytes, limits.maxInputBytes);

  const decoded = Buffer.from(normalized, "base64");
  assertByteLimit("decode-input", "nbtBase64", decoded.length, limits.maxInputBytes);
  return decoded;
}

function isGzipBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export function nbtBase64ToTypedJson(
  input: NbtToJsonInput,
  limits: NbtLimits = DEFAULT_NBT_LIMITS
): NbtToJsonOutput {
  const compression = parseDecodeCompression(input.compression);
  const encoded = decodeBase64Nbt(input.nbtBase64, limits);
  let payload = encoded;
  let compressionDetected: "none" | "gzip" = "none";

  if (compression === "gzip" || (compression === "auto" && isGzipBuffer(encoded))) {
    try {
      payload = gunzipSync(encoded, { maxOutputLength: limits.maxInflatedBytes });
    } catch (error) {
      if (isInflateLimitError(error)) {
        limitExceeded("inflate", "nbtBase64", limits.maxInflatedBytes + 1, limits.maxInflatedBytes);
      }
      inflateParseFailed(error);
    }
    compressionDetected = "gzip";
  }

  const typedJson = decodeJavaNbt(payload);
  assertByteLimit("decode-output", "typedJson", jsonUtf8Bytes(typedJson), limits.maxResponseBytes);

  return {
    typedJson,
    meta: {
      compressionDetected,
      inputBytes: encoded.length
    }
  };
}

export function typedJsonToNbtBase64(
  input: JsonToNbtInput,
  limits: NbtLimits = DEFAULT_NBT_LIMITS
): JsonToNbtOutput {
  const compression = parseEncodeCompression(input.compression);
  assertValidTypedNbtDocument(input.typedJson);

  let output = encodeJavaNbt(input.typedJson);
  if (compression === "gzip") {
    output = gzipSync(output);
  }

  const nbtBase64 = output.toString("base64");
  assertByteLimit(
    "encode-output",
    "result",
    Buffer.byteLength(nbtBase64, "utf8"),
    limits.maxResponseBytes
  );

  return {
    nbtBase64,
    meta: {
      outputBytes: output.length,
      compressionApplied: compression
    }
  };
}

export function applyNbtJsonPatch(
  input: ApplyPatchInput,
  limits: NbtLimits = DEFAULT_NBT_LIMITS
): ApplyJsonPatchResult {
  assertValidTypedNbtDocument(input.typedJson);
  const patched = applyJsonPatch(input.typedJson, input.patch);
  assertByteLimit("patch-output", "typedJson", jsonUtf8Bytes(patched.typedJson), limits.maxResponseBytes);
  return patched;
}
