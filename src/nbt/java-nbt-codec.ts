import { createError, ERROR_CODES, isAppError } from "../errors.js";

import { assertValidTypedNbtDocument, type TypedNbtDocument } from "./typed-json.js";
import type { NbtListElementType, NbtNode, NbtTagName } from "./types.js";

const TAG_ID_BY_NAME: Record<NbtTagName, number> = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12
};

const TAG_NAME_BY_ID: Record<number, NbtTagName> = Object.fromEntries(
  Object.entries(TAG_ID_BY_NAME).map(([name, id]) => [id, name as NbtTagName])
) as Record<number, NbtTagName>;

function parseError(message: string, details?: Record<string, unknown>) {
  return createError({
    code: ERROR_CODES.NBT_PARSE_FAILED,
    message,
    details
  });
}

function encodeError(message: string, details?: Record<string, unknown>) {
  return createError({
    code: ERROR_CODES.NBT_ENCODE_FAILED,
    message,
    details
  });
}

function resolveTagName(tagId: number, pointer: string): NbtTagName {
  const tagName = TAG_NAME_BY_ID[tagId];
  if (!tagName) {
    throw parseError("Unknown NBT tag id.", { tagId, jsonPointer: pointer });
  }
  return tagName;
}

class NbtReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  private ensure(length: number): void {
    if (this.offset + length > this.buffer.length) {
      throw parseError("Unexpected end of NBT payload.", {
        offset: this.offset,
        requiredBytes: length,
        remainingBytes: this.buffer.length - this.offset
      });
    }
  }

  readUInt8(): number {
    this.ensure(1);
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt8(): number {
    this.ensure(1);
    const value = this.buffer.readInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt16(): number {
    this.ensure(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt16(): number {
    this.ensure(2);
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  readInt32(): number {
    this.ensure(4);
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readFloat32(): number {
    this.ensure(4);
    const value = this.buffer.readFloatBE(this.offset);
    this.offset += 4;
    return value;
  }

  readFloat64(): number {
    this.ensure(8);
    const value = this.buffer.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  readInt64(): bigint {
    this.ensure(8);
    const value = this.buffer.readBigInt64BE(this.offset);
    this.offset += 8;
    return value;
  }

  readString(): string {
    const byteLength = this.readUInt16();
    this.ensure(byteLength);
    const value = this.buffer.toString("utf8", this.offset, this.offset + byteLength);
    this.offset += byteLength;
    return value;
  }

  remainingBytes(): number {
    return this.buffer.length - this.offset;
  }
}

class NbtWriter {
  private readonly chunks: Buffer[] = [];

  writeUInt8(value: number): void {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeUInt8(value, 0);
    this.chunks.push(chunk);
  }

  writeInt8(value: number): void {
    const chunk = Buffer.allocUnsafe(1);
    chunk.writeInt8(value, 0);
    this.chunks.push(chunk);
  }

  writeUInt16(value: number): void {
    const chunk = Buffer.allocUnsafe(2);
    chunk.writeUInt16BE(value, 0);
    this.chunks.push(chunk);
  }

  writeInt16(value: number): void {
    const chunk = Buffer.allocUnsafe(2);
    chunk.writeInt16BE(value, 0);
    this.chunks.push(chunk);
  }

  writeInt32(value: number): void {
    const chunk = Buffer.allocUnsafe(4);
    chunk.writeInt32BE(value, 0);
    this.chunks.push(chunk);
  }

  writeFloat32(value: number): void {
    const chunk = Buffer.allocUnsafe(4);
    chunk.writeFloatBE(value, 0);
    this.chunks.push(chunk);
  }

  writeFloat64(value: number): void {
    const chunk = Buffer.allocUnsafe(8);
    chunk.writeDoubleBE(value, 0);
    this.chunks.push(chunk);
  }

  writeInt64(value: bigint): void {
    const chunk = Buffer.allocUnsafe(8);
    chunk.writeBigInt64BE(value, 0);
    this.chunks.push(chunk);
  }

  writeString(value: string): void {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.length > 0xffff) {
      throw encodeError("NBT string length exceeds uint16.", { byteLength: encoded.length });
    }
    this.writeUInt16(encoded.length);
    this.chunks.push(encoded);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function readPayload(reader: NbtReader, tagId: number, pointer: string): NbtNode {
  const tagName = resolveTagName(tagId, pointer);

  switch (tagName) {
    case "byte":
      return { type: "byte", value: reader.readInt8() };
    case "short":
      return { type: "short", value: reader.readInt16() };
    case "int":
      return { type: "int", value: reader.readInt32() };
    case "long":
      return { type: "long", value: reader.readInt64().toString() };
    case "float":
      return { type: "float", value: reader.readFloat32() };
    case "double":
      return { type: "double", value: reader.readFloat64() };
    case "byteArray": {
      const length = reader.readInt32();
      if (length < 0) {
        throw parseError("NBT byte array length cannot be negative.", {
          length,
          jsonPointer: pointer
        });
      }
      const value: number[] = [];
      for (let i = 0; i < length; i += 1) {
        value.push(reader.readInt8());
      }
      return { type: "byteArray", value };
    }
    case "string":
      return { type: "string", value: reader.readString() };
    case "list": {
      const elementTagId = reader.readUInt8();
      const elementType = resolveTagName(elementTagId, `${pointer}/elementType`) as NbtListElementType;
      const length = reader.readInt32();
      if (length < 0) {
        throw parseError("NBT list length cannot be negative.", {
          length,
          jsonPointer: pointer
        });
      }
      if (elementType === "end" && length > 0) {
        throw parseError("NBT list with elementType end must be empty.", {
          length,
          jsonPointer: pointer
        });
      }
      const value: NbtNode[] = [];
      for (let i = 0; i < length; i += 1) {
        value.push(readPayload(reader, elementTagId, `${pointer}/value/${i}`));
      }
      return {
        type: "list",
        elementType,
        value
      };
    }
    case "compound": {
      const value: Record<string, NbtNode> = {};
      while (true) {
        const childType = reader.readUInt8();
        if (childType === TAG_ID_BY_NAME.end) {
          break;
        }
        const childName = reader.readString();
        value[childName] = readPayload(reader, childType, `${pointer}/value/${childName}`);
      }
      return { type: "compound", value };
    }
    case "intArray": {
      const length = reader.readInt32();
      if (length < 0) {
        throw parseError("NBT int array length cannot be negative.", {
          length,
          jsonPointer: pointer
        });
      }
      const value: number[] = [];
      for (let i = 0; i < length; i += 1) {
        value.push(reader.readInt32());
      }
      return { type: "intArray", value };
    }
    case "longArray": {
      const length = reader.readInt32();
      if (length < 0) {
        throw parseError("NBT long array length cannot be negative.", {
          length,
          jsonPointer: pointer
        });
      }
      const value: string[] = [];
      for (let i = 0; i < length; i += 1) {
        value.push(reader.readInt64().toString());
      }
      return { type: "longArray", value };
    }
    case "end":
      throw parseError("TAG_End is only valid as a compound terminator.", {
        jsonPointer: pointer
      });
    default:
      throw parseError("Unsupported NBT tag encountered.", {
        jsonPointer: pointer,
        tagName
      });
  }
}

function writePayload(writer: NbtWriter, node: NbtNode, pointer: string): void {
  switch (node.type) {
    case "byte":
      writer.writeInt8(node.value);
      return;
    case "short":
      writer.writeInt16(node.value);
      return;
    case "int":
      writer.writeInt32(node.value);
      return;
    case "long":
      writer.writeInt64(BigInt(node.value));
      return;
    case "float":
      writer.writeFloat32(node.value);
      return;
    case "double":
      writer.writeFloat64(node.value);
      return;
    case "byteArray":
      writer.writeInt32(node.value.length);
      for (const value of node.value) {
        writer.writeInt8(value);
      }
      return;
    case "string":
      writer.writeString(node.value);
      return;
    case "list":
      writer.writeUInt8(TAG_ID_BY_NAME[node.elementType]);
      writer.writeInt32(node.value.length);
      for (let i = 0; i < node.value.length; i += 1) {
        writePayload(writer, node.value[i], `${pointer}/value/${i}`);
      }
      return;
    case "compound":
      for (const [name, child] of Object.entries(node.value)) {
        writer.writeUInt8(TAG_ID_BY_NAME[child.type]);
        writer.writeString(name);
        writePayload(writer, child, `${pointer}/value/${name}`);
      }
      writer.writeUInt8(TAG_ID_BY_NAME.end);
      return;
    case "intArray":
      writer.writeInt32(node.value.length);
      for (const value of node.value) {
        writer.writeInt32(value);
      }
      return;
    case "longArray":
      writer.writeInt32(node.value.length);
      for (const value of node.value) {
        writer.writeInt64(BigInt(value));
      }
      return;
    default:
      throw encodeError("Unsupported typed NBT node for encoding.", {
        jsonPointer: pointer,
        nodeType: (node as { type?: unknown }).type
      });
  }
}

export function decodeJavaNbt(buffer: Buffer): TypedNbtDocument {
  try {
    const reader = new NbtReader(buffer);
    const rootTagId = reader.readUInt8();
    if (rootTagId === TAG_ID_BY_NAME.end) {
      throw parseError("Root NBT tag cannot be TAG_End.");
    }

    const rootName = reader.readString();
    const root = readPayload(reader, rootTagId, "/root");
    const document: TypedNbtDocument = { rootName, root };

    if (reader.remainingBytes() > 0) {
      throw parseError("Trailing bytes remain after decoding NBT payload.", {
        trailingBytes: reader.remainingBytes()
      });
    }

    assertValidTypedNbtDocument(document);
    return document;
  } catch (error) {
    if (isAppError(error)) {
      if (
        error.code === ERROR_CODES.NBT_PARSE_FAILED ||
        error.code === ERROR_CODES.NBT_INVALID_TYPED_JSON
      ) {
        throw error;
      }
    }
    throw parseError("Failed to decode Java NBT payload.");
  }
}

export function encodeJavaNbt(document: TypedNbtDocument): Buffer {
  assertValidTypedNbtDocument(document);
  try {
    const writer = new NbtWriter();
    writer.writeUInt8(TAG_ID_BY_NAME[document.root.type]);
    writer.writeString(document.rootName);
    writePayload(writer, document.root, "/root");
    return writer.toBuffer();
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === ERROR_CODES.NBT_INVALID_TYPED_JSON || error.code === ERROR_CODES.NBT_ENCODE_FAILED) {
        throw error;
      }
    }
    throw encodeError("Failed to encode Java NBT payload.");
  }
}
