import { createError, ERROR_CODES } from "./errors.js";
import { loadConfig } from "./config.js";
import { artifactSignatureFromFile, normalizeJarPath } from "./path-resolver.js";
import { readJarEntryAsBuffer } from "./source-jar-reader.js";
import type { Config } from "./types.js";

export type MappingNamespace = "obfuscated" | "mojang" | "yarn";

type SignatureAccess = "public" | "all";

export interface ResponseContext {
  minecraftVersion: string;
  mappingType: string;
  mappingNamespace: MappingNamespace;
  jarHash: string;
  generatedAt: string;
}

interface ParsedClassMember {
  name: string;
  descriptor: string;
  accessFlags: number;
  isSynthetic: boolean;
}

interface ParsedClassFile {
  internalName: string;
  superInternalName: string | undefined;
  interfaceInternalNames: string[];
  fields: ParsedClassMember[];
  methods: ParsedClassMember[];
}

export interface SignatureMember {
  ownerFqn: string;
  name: string;
  javaSignature: string;
  jvmDescriptor: string;
  accessFlags: number;
  isSynthetic: boolean;
}

export interface GetSignatureInput {
  fqn: string;
  jarPath: string;
  memberPattern?: string;
  access?: SignatureAccess;
  includeSynthetic?: boolean;
  includeInherited?: boolean;
}

export interface GetSignatureOutput {
  constructors: SignatureMember[];
  methods: SignatureMember[];
  fields: SignatureMember[];
  warnings: string[];
  context: ResponseContext;
}

type CachedSignatureOutput = Omit<GetSignatureOutput, "context">;

const CLASSFILE_MAGIC = 0xcafebabe;
const MAX_INHERITANCE_DEPTH = 64;

const ACC_PUBLIC = 0x0001;
const ACC_PRIVATE = 0x0002;
const ACC_PROTECTED = 0x0004;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SYNCHRONIZED = 0x0020;
const ACC_VOLATILE = 0x0040;
const ACC_BRIDGE = 0x0040;
const ACC_TRANSIENT = 0x0080;
const ACC_VARARGS = 0x0080;
const ACC_NATIVE = 0x0100;
const ACC_ABSTRACT = 0x0400;
const ACC_STRICT = 0x0800;
const ACC_SYNTHETIC = 0x1000;

function lower(value: string): string {
  return value.toLocaleLowerCase();
}

function modifierPrefix(flags: number, category: "method" | "field"): string {
  const parts: string[] = [];
  if ((flags & ACC_PUBLIC) !== 0) {
    parts.push("public");
  } else if ((flags & ACC_PROTECTED) !== 0) {
    parts.push("protected");
  } else if ((flags & ACC_PRIVATE) !== 0) {
    parts.push("private");
  }
  if ((flags & ACC_STATIC) !== 0) {
    parts.push("static");
  }
  if ((flags & ACC_FINAL) !== 0) {
    parts.push("final");
  }
  if (category === "method") {
    if ((flags & ACC_ABSTRACT) !== 0) {
      parts.push("abstract");
    }
    if ((flags & ACC_SYNCHRONIZED) !== 0) {
      parts.push("synchronized");
    }
    if ((flags & ACC_NATIVE) !== 0) {
      parts.push("native");
    }
    if ((flags & ACC_STRICT) !== 0) {
      parts.push("strictfp");
    }
    if ((flags & ACC_BRIDGE) !== 0) {
      parts.push("bridge");
    }
    if ((flags & ACC_VARARGS) !== 0) {
      parts.push("varargs");
    }
  } else {
    if ((flags & ACC_VOLATILE) !== 0) {
      parts.push("volatile");
    }
    if ((flags & ACC_TRANSIENT) !== 0) {
      parts.push("transient");
    }
  }
  return parts.join(" ");
}

function parseFieldType(
  descriptor: string,
  position = 0,
  options: { allowVoid?: boolean; invalidVoidMessage?: string } = {}
): { type: string; next: number } {
  if (position >= descriptor.length) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Unexpected end of descriptor.",
      details: { descriptor, position }
    });
  }

  const token = descriptor[position]!;
  switch (token) {
    case "B":
      return { type: "byte", next: position + 1 };
    case "C":
      return { type: "char", next: position + 1 };
    case "D":
      return { type: "double", next: position + 1 };
    case "F":
      return { type: "float", next: position + 1 };
    case "I":
      return { type: "int", next: position + 1 };
    case "J":
      return { type: "long", next: position + 1 };
    case "S":
      return { type: "short", next: position + 1 };
    case "Z":
      return { type: "boolean", next: position + 1 };
    case "V":
      if (!options.allowVoid) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: options.invalidVoidMessage ?? `Invalid field descriptor "${descriptor}".`,
          details: { descriptor, position }
        });
      }
      return { type: "void", next: position + 1 };
    case "L": {
      const end = descriptor.indexOf(";", position);
      if (end < 0) {
        throw createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: `Invalid descriptor: ${descriptor}`,
          details: { descriptor, position }
        });
      }
      const type = descriptor.slice(position + 1, end).replace(/\//g, ".");
      return { type, next: end + 1 };
    }
    case "[": {
      const inner = parseFieldType(descriptor, position + 1, options);
      return { type: `${inner.type}[]`, next: inner.next };
    }
    default:
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Unsupported descriptor token "${token}" in "${descriptor}".`,
        details: { descriptor, token, position }
      });
  }
}

function parseMethodDescriptor(descriptor: string): { args: string[]; returnType: string } {
  if (!descriptor.startsWith("(")) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Invalid method descriptor "${descriptor}".`,
      details: { descriptor }
    });
  }

  const args: string[] = [];
  let cursor = 1;
  while (cursor < descriptor.length && descriptor[cursor] !== ")") {
    const parsed = parseFieldType(descriptor, cursor, {
      allowVoid: false,
      invalidVoidMessage: `Invalid method descriptor "${descriptor}": void is not allowed in this position.`
    });
    args.push(parsed.type);
    cursor = parsed.next;
  }
  if (descriptor[cursor] !== ")") {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Invalid method descriptor "${descriptor}".`,
      details: { descriptor, cursor }
    });
  }

  const parsedReturn = parseFieldType(descriptor, cursor + 1, { allowVoid: true });
  if (parsedReturn.next !== descriptor.length) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: `Invalid method descriptor "${descriptor}".`,
      details: { descriptor, cursor: parsedReturn.next }
    });
  }
  const returnType = parsedReturn.type;
  return { args, returnType };
}

function hasPublicVisibility(flags: number): boolean {
  return (flags & ACC_PUBLIC) !== 0 || (flags & ACC_PROTECTED) !== 0;
}

function toInternalName(fqn: string): string {
  return fqn.trim().replace(/\./g, "/");
}

function extractVersionFromPath(inputPath: string): string | undefined {
  return inputPath.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
}

type SignatureCacheNode = {
  key: string;
  value: CachedSignatureOutput;
  older?: SignatureCacheNode;
  newer?: SignatureCacheNode;
};

class SignatureCacheStore {
  private readonly nodes = new Map<string, SignatureCacheNode>();
  private oldest?: SignatureCacheNode;
  private newest?: SignatureCacheNode;

  constructor(private readonly maxEntries: number) {}

  get(key: string): CachedSignatureOutput | undefined {
    const node = this.nodes.get(key);
    if (!node) {
      return undefined;
    }

    this.promote(node);
    return node.value;
  }

  set(key: string, value: CachedSignatureOutput): void {
    const existing = this.nodes.get(key);
    if (existing) {
      existing.value = value;
      this.promote(existing);
      return;
    }

    const node: SignatureCacheNode = { key, value, older: this.newest };
    if (this.newest) {
      this.newest.newer = node;
    } else {
      this.oldest = node;
    }
    this.newest = node;
    this.nodes.set(key, node);

    while (this.nodes.size > this.maxEntries) {
      this.evictOldest();
    }
  }

  private promote(node: SignatureCacheNode): void {
    if (this.newest === node) {
      return;
    }

    if (node.older) {
      node.older.newer = node.newer;
    } else {
      this.oldest = node.newer;
    }

    if (node.newer) {
      node.newer.older = node.older;
    }

    node.older = this.newest;
    node.newer = undefined;
    if (this.newest) {
      this.newest.newer = node;
    } else {
      this.oldest = node;
    }
    this.newest = node;
  }

  private evictOldest(): void {
    const node = this.oldest;
    if (!node) {
      return;
    }

    this.oldest = node.newer;
    if (this.oldest) {
      this.oldest.older = undefined;
    } else {
      this.newest = undefined;
    }

    this.nodes.delete(node.key);
  }
}

class ByteReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  public readU1(): number {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  public readU2(): number {
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  public readU4(): number {
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  public readBytes(length: number): Buffer {
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  public skip(length: number): void {
    this.offset += length;
  }
}

type ConstantPoolEntry =
  | { tag: 1; value: string }
  | { tag: 7 | 8 | 16 | 19 | 20; index: number }
  | { tag: 9 | 10 | 11 | 12 | 17 | 18; index1: number; index2: number }
  | { tag: 15; refKind: number; refIndex: number }
  | { tag: 3 | 4 | 5 | 6 };

function readUtf8(cp: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = cp[index];
  if (!entry || entry.tag !== 1) {
    throw createError({
      code: ERROR_CODES.CLASS_NOT_FOUND,
      message: `Invalid UTF8 constant pool index ${index}. Class file may be corrupted.`,
      details: { index }
    });
  }
  return entry.value;
}

function readClassName(cp: Array<ConstantPoolEntry | undefined>, index: number): string {
  const entry = cp[index];
  if (!entry || entry.tag !== 7) {
    throw createError({
      code: ERROR_CODES.CLASS_NOT_FOUND,
      message: `Invalid class constant pool index ${index}. Class file may be corrupted.`,
      details: { index }
    });
  }
  return readUtf8(cp, entry.index);
}

function readOptionalClassName(
  cp: Array<ConstantPoolEntry | undefined>,
  index: number
): string | undefined {
  if (index === 0) {
    return undefined;
  }
  return readClassName(cp, index);
}

function readAttributes(
  reader: ByteReader,
  cp: Array<ConstantPoolEntry | undefined>,
  count: number
): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameIndex = reader.readU2();
    const length = reader.readU4();
    const attributeName = readUtf8(cp, nameIndex);
    names.push(attributeName);
    reader.skip(length);
  }
  return names;
}

function parseClassFile(buffer: Buffer): ParsedClassFile {
  const reader = new ByteReader(buffer);
  if (reader.readU4() !== CLASSFILE_MAGIC) {
    throw createError({
      code: ERROR_CODES.INTERNAL,
      message: "Invalid class file magic. File is not a valid Java class."
    });
  }

  reader.readU2();
  reader.readU2();
  const cpCount = reader.readU2();
  const cp: Array<ConstantPoolEntry | undefined> = new Array(cpCount).fill(undefined);

  for (let index = 1; index < cpCount; index += 1) {
    const tag = reader.readU1();
    switch (tag) {
      case 1: {
        const length = reader.readU2();
        cp[index] = { tag: 1, value: reader.readBytes(length).toString("utf8") };
        break;
      }
      case 3:
      case 4:
        reader.skip(4);
        cp[index] = { tag };
        break;
      case 5:
      case 6:
        reader.skip(8);
        cp[index] = { tag };
        index += 1;
        break;
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        cp[index] = { tag, index: reader.readU2() };
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        cp[index] = { tag, index1: reader.readU2(), index2: reader.readU2() };
        break;
      case 15:
        cp[index] = { tag, refKind: reader.readU1(), refIndex: reader.readU2() };
        break;
      default:
        throw createError({
          code: ERROR_CODES.INTERNAL,
          message: `Unsupported constant pool tag ${tag}. Class file may be corrupted.`,
          details: { tag, index }
        });
    }
  }

  reader.readU2();
  const thisClassIndex = reader.readU2();
  const superClassIndex = reader.readU2();

  const interfacesCount = reader.readU2();
  const interfaceInternalNames: string[] = [];
  for (let index = 0; index < interfacesCount; index += 1) {
    interfaceInternalNames.push(readClassName(cp, reader.readU2()));
  }

  const readMembers = (): ParsedClassMember[] => {
    const count = reader.readU2();
    const members: ParsedClassMember[] = [];
    for (let index = 0; index < count; index += 1) {
      const accessFlags = reader.readU2();
      const nameIndex = reader.readU2();
      const descriptorIndex = reader.readU2();
      const attributesCount = reader.readU2();
      const attributeNames = readAttributes(reader, cp, attributesCount);
      members.push({
        name: readUtf8(cp, nameIndex),
        descriptor: readUtf8(cp, descriptorIndex),
        accessFlags,
        isSynthetic:
          (accessFlags & ACC_SYNTHETIC) !== 0 ||
          attributeNames.some((attributeName) => attributeName === "Synthetic")
      });
    }
    return members;
  };

  const fields = readMembers();
  const methods = readMembers();

  const attributesCount = reader.readU2();
  readAttributes(reader, cp, attributesCount);

  return {
    internalName: readClassName(cp, thisClassIndex),
    superInternalName: readOptionalClassName(cp, superClassIndex),
    interfaceInternalNames,
    fields,
    methods
  };
}

export class MinecraftExplorerService {
  private readonly config: Config;
  private readonly signatureCache: SignatureCacheStore;

  constructor(explicitConfig?: Config) {
    this.config = explicitConfig ?? loadConfig();
    this.signatureCache = new SignatureCacheStore(Math.max(1, this.config.maxSignatureCache ?? 2_000));
  }

  public async getSignature(input: GetSignatureInput): Promise<GetSignatureOutput> {
    const jarPath = this.normalizeJarPathOrThrow(input.jarPath);
    const fqn = input.fqn.trim();
    if (!fqn) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "fqn must be a non-empty string."
      });
    }

    const access = input.access ?? "public";
    const includeSynthetic = input.includeSynthetic ?? false;
    const includeInherited = input.includeInherited ?? false;
    const memberPattern = input.memberPattern ? lower(input.memberPattern) : undefined;
    const cacheKey = [
      jarPath,
      fqn,
      access,
      includeSynthetic ? "1" : "0",
      includeInherited ? "1" : "0",
      memberPattern ?? ""
    ].join("|");
    const cached = this.signatureCache.get(cacheKey);
    if (cached) {
      return {
        constructors: cached.constructors,
        methods: cached.methods,
        fields: cached.fields,
        warnings: cached.warnings,
        context: this.contextForJar(jarPath)
      };
    }

    const classEntryPath = `${toInternalName(fqn)}.class`;
    let classBuffer: Buffer;
    try {
      classBuffer = await readJarEntryAsBuffer(jarPath, classEntryPath);
    } catch {
      throw createError({
        code: ERROR_CODES.CLASS_NOT_FOUND,
        message: `Class "${fqn}" was not found in "${jarPath}".`,
        details: { fqn, jarPath, classEntryPath }
      });
    }

    const parsed = parseClassFile(classBuffer);
    const parsedClassCache = new Map<string, ParsedClassFile>([[parsed.internalName, parsed]]);
    const warnings: string[] = [];
    const warnMissingInheritedClass = (internalName: string, relation: "super" | "interface"): void => {
      warnings.push(
        `Could not resolve ${relation} class "${internalName.replace(/\//g, ".")}" while expanding inherited members.`
      );
    };
    const readParsedClassByInternalName = async (
      internalName: string,
      relation: "super" | "interface"
    ): Promise<ParsedClassFile | undefined> => {
      const cachedParsed = parsedClassCache.get(internalName);
      if (cachedParsed) {
        return cachedParsed;
      }

      const classPath = `${internalName}.class`;
      try {
        const classBytes = await readJarEntryAsBuffer(jarPath, classPath);
        const parsedClass = parseClassFile(classBytes);
        parsedClassCache.set(parsedClass.internalName, parsedClass);
        return parsedClass;
      } catch {
        warnMissingInheritedClass(internalName, relation);
        return undefined;
      }
    };

    const hierarchyClasses: ParsedClassFile[] = [parsed];
    if (includeInherited) {
      const visited = new Set<string>([parsed.internalName]);
      let currentSuper = parsed.superInternalName;
      let depth = 0;
      while (currentSuper) {
        if (depth >= MAX_INHERITANCE_DEPTH) {
          warnings.push(
            `Stopped inherited member expansion at depth ${MAX_INHERITANCE_DEPTH} while resolving "${fqn}".`
          );
          break;
        }
        if (visited.has(currentSuper)) {
          warnings.push(`Detected class hierarchy cycle at "${currentSuper.replace(/\//g, ".")}".`);
          break;
        }
        const parsedSuper = await readParsedClassByInternalName(currentSuper, "super");
        if (!parsedSuper) {
          break;
        }
        visited.add(parsedSuper.internalName);
        hierarchyClasses.push(parsedSuper);
        currentSuper = parsedSuper.superInternalName;
        depth += 1;
      }

      const queue: string[] = [];
      const queued = new Set<string>();
      const interfaceClasses: ParsedClassFile[] = [];
      const enqueueInterfaces = (classFile: ParsedClassFile): void => {
        for (const interfaceInternalName of classFile.interfaceInternalNames) {
          if (visited.has(interfaceInternalName) || queued.has(interfaceInternalName)) {
            continue;
          }
          queue.push(interfaceInternalName);
          queued.add(interfaceInternalName);
        }
      };

      for (const classFile of hierarchyClasses) {
        enqueueInterfaces(classFile);
      }

      while (queue.length > 0) {
        const interfaceInternalName = queue.shift() as string;
        queued.delete(interfaceInternalName);
        if (visited.has(interfaceInternalName)) {
          continue;
        }

        const parsedInterface = await readParsedClassByInternalName(interfaceInternalName, "interface");
        if (!parsedInterface) {
          continue;
        }
        visited.add(parsedInterface.internalName);
        interfaceClasses.push(parsedInterface);
        enqueueInterfaces(parsedInterface);
      }

      hierarchyClasses.push(...interfaceClasses);
    }

    const toSignatureMember = (
      ownerFqn: string,
      ownerSimpleClassName: string,
      member: ParsedClassMember,
      category: "method" | "field"
    ): SignatureMember => {
      if (category === "field") {
        const parsedField = parseFieldType(member.descriptor, 0, { allowVoid: false });
        if (parsedField.next !== member.descriptor.length) {
          throw createError({
            code: ERROR_CODES.INVALID_INPUT,
            message: `Invalid field descriptor "${member.descriptor}".`,
            details: { descriptor: member.descriptor, position: parsedField.next }
          });
        }
        const fieldType = parsedField.type;
        const modifiers = modifierPrefix(member.accessFlags, "field");
        return {
          ownerFqn,
          name: member.name,
          javaSignature: `${modifiers ? `${modifiers} ` : ""}${fieldType} ${member.name}`.trim(),
          jvmDescriptor: member.descriptor,
          accessFlags: member.accessFlags,
          isSynthetic: member.isSynthetic
        };
      }

      const parsedMethod = parseMethodDescriptor(member.descriptor);
      const modifiers = modifierPrefix(member.accessFlags, "method");
      const args = parsedMethod.args.join(", ");
      if (member.name === "<init>") {
        return {
          ownerFqn,
          name: member.name,
          javaSignature: `${modifiers ? `${modifiers} ` : ""}${ownerSimpleClassName}(${args})`.trim(),
          jvmDescriptor: member.descriptor,
          accessFlags: member.accessFlags,
          isSynthetic: member.isSynthetic
        };
      }

      return {
        ownerFqn,
        name: member.name,
        javaSignature: `${modifiers ? `${modifiers} ` : ""}${parsedMethod.returnType} ${member.name}(${args})`.trim(),
        jvmDescriptor: member.descriptor,
        accessFlags: member.accessFlags,
        isSynthetic: member.isSynthetic
      };
    };

    const shouldIncludeMember = (member: ParsedClassMember): boolean => {
      if (!includeSynthetic && member.isSynthetic) {
        return false;
      }
      if (access === "public" && !hasPublicVisibility(member.accessFlags)) {
        return false;
      }
      if (memberPattern && !lower(member.name).includes(memberPattern)) {
        return false;
      }
      return true;
    };

    const toMembers = (
      classFile: ParsedClassFile,
      category: "method" | "field",
      predicate: (member: ParsedClassMember) => boolean
    ): SignatureMember[] => {
      const ownerFqn = classFile.internalName.replace(/\//g, ".");
      const ownerSimpleClassName = ownerFqn.split(".").at(-1) ?? ownerFqn;
      const sourceMembers = category === "field" ? classFile.fields : classFile.methods;
      return sourceMembers
        .filter(predicate)
        .map((member) => toSignatureMember(ownerFqn, ownerSimpleClassName, member, category));
    };

    const dedupeMembers = (members: SignatureMember[]): SignatureMember[] => {
      const seen = new Set<string>();
      const result: SignatureMember[] = [];
      for (const member of members) {
        const key = `${member.ownerFqn}|${member.name}|${member.jvmDescriptor}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(member);
      }
      return result;
    };

    const targetClass = hierarchyClasses[0] as ParsedClassFile;
    const constructors = toMembers(
      targetClass,
      "method",
      (member) => member.name === "<init>" && shouldIncludeMember(member)
    );
    const fields = dedupeMembers(
      hierarchyClasses.flatMap((classFile) =>
        toMembers(classFile, "field", (member) => shouldIncludeMember(member))
      )
    );
    const methods = dedupeMembers(
      hierarchyClasses.flatMap((classFile) =>
        toMembers(
          classFile,
          "method",
          (member) => member.name !== "<init>" && shouldIncludeMember(member)
        )
      )
    );

    const output: CachedSignatureOutput = {
      constructors,
      methods,
      fields,
      warnings
    };
    this.signatureCache.set(cacheKey, output);
    return {
      constructors: output.constructors,
      methods: output.methods,
      fields: output.fields,
      warnings: output.warnings,
      context: this.contextForJar(jarPath)
    };
  }

  private contextForJar(jarPath: string): ResponseContext {
    return {
      minecraftVersion: extractVersionFromPath(jarPath) ?? "unknown",
      mappingType: "unknown",
      mappingNamespace: "obfuscated",
      jarHash: artifactSignatureFromFile(jarPath).sourceArtifactId,
      generatedAt: new Date().toISOString()
    };
  }

  private normalizeJarPathOrThrow(jarPath: string): string {
    try {
      return normalizeJarPath(jarPath);
    } catch (error) {
      throw createError({
        code: ERROR_CODES.JAR_NOT_FOUND,
        message: error instanceof Error ? error.message : `Could not resolve jar "${jarPath}".`,
        details: { jarPath }
      });
    }
  }
}
