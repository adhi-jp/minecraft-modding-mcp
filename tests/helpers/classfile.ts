interface AttributeSpec {
  name: string;
  /**
   * Raw attribute body, or a builder invoked with the pool API so the body
   * can reference constant-pool entries (annotation attributes need utf8 or
   * integer indices for type descriptors and element values).
   */
  info?: Buffer | ((pool: ClassFilePoolApi) => Buffer);
}

export interface ClassMemberSpec {
  name: string;
  descriptor: string;
  accessFlags?: number;
  attributes?: AttributeSpec[];
}

export interface ClassFilePoolApi {
  addUtf8(value: string): number;
  addInteger(value: number): number;
  addFloat(value: number): number;
  addLong(value: bigint): number;
  addDouble(value: number): number;
}

export interface ClassFileSpec {
  internalName: string;
  superInternalName?: string;
  interfaceInternalNames?: string[];
  accessFlags?: number;
  fields?: ClassMemberSpec[];
  methods?: ClassMemberSpec[];
  attributes?: AttributeSpec[];
}

function u1(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

function u2(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value & 0xffff, 0);
  return buffer;
}

function u4(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

export function buildClassFile(spec: ClassFileSpec): Buffer {
  const constantPool: Buffer[] = [];
  const utf8Indexes = new Map<string, number>();
  const classIndexes = new Map<string, number>();

  const addEntry = (entry: Buffer): number => {
    constantPool.push(entry);
    return constantPool.length;
  };

  const addUtf8 = (value: string): number => {
    const existing = utf8Indexes.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const bytes = Buffer.from(value, "utf8");
    const index = addEntry(Buffer.concat([u1(1), u2(bytes.length), bytes]));
    utf8Indexes.set(value, index);
    return index;
  };

  const addInteger = (value: number): number => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(value | 0, 0);
    return addEntry(Buffer.concat([u1(3), bytes]));
  };

  const addFloat = (value: number): number => {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatBE(value, 0);
    return addEntry(Buffer.concat([u1(4), bytes]));
  };

  // Long/double constants occupy TWO pool slots (JVMS 4.4.5): push the data
  // entry, then a zero-byte phantom entry so later indices stay aligned.
  const addLong = (value: bigint): number => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(value, 0);
    const index = addEntry(Buffer.concat([u1(5), bytes]));
    constantPool.push(Buffer.alloc(0));
    return index;
  };

  const addDouble = (value: number): number => {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value, 0);
    const index = addEntry(Buffer.concat([u1(6), bytes]));
    constantPool.push(Buffer.alloc(0));
    return index;
  };

  const addClass = (internalName: string): number => {
    const existing = classIndexes.get(internalName);
    if (existing !== undefined) {
      return existing;
    }
    const nameIndex = addUtf8(internalName);
    const index = addEntry(Buffer.concat([u1(7), u2(nameIndex)]));
    classIndexes.set(internalName, index);
    return index;
  };

  const superInternalName = Object.prototype.hasOwnProperty.call(spec, "superInternalName")
    ? spec.superInternalName
    : spec.internalName === "java/lang/Object"
      ? undefined
      : "java/lang/Object";
  const thisClassIndex = addClass(spec.internalName);
  const superClassIndex = superInternalName ? addClass(superInternalName) : 0;
  const interfaceIndexes = (spec.interfaceInternalNames ?? []).map((internalName) => addClass(internalName));

  // Function-valued attribute bodies must run BEFORE the constant-pool count
  // is serialized (they may add utf8 entries), so materialize them here.
  const materializedInfo = new Map<AttributeSpec, Buffer>();
  const preloadAttributes = (attributes: AttributeSpec[] = []): void => {
    for (const attribute of attributes) {
      addUtf8(attribute.name);
      const rawInfo = attribute.info;
      if (typeof rawInfo === "function") {
        materializedInfo.set(attribute, rawInfo({ addUtf8, addInteger, addFloat, addLong, addDouble }));
      }
    }
  };

  const preloadMembers = (members: ClassMemberSpec[] = []): void => {
    for (const member of members) {
      addUtf8(member.name);
      addUtf8(member.descriptor);
      preloadAttributes(member.attributes);
    }
  };

  preloadMembers(spec.fields);
  preloadMembers(spec.methods);
  preloadAttributes(spec.attributes);

  const encodeAttributes = (attributes: AttributeSpec[] = []): Buffer => {
    return Buffer.concat([
      u2(attributes.length),
      ...attributes.map((attribute) => {
        const rawInfo = attribute.info;
        const info =
          typeof rawInfo === "function"
            ? (materializedInfo.get(attribute) ?? rawInfo({ addUtf8, addInteger, addFloat, addLong, addDouble }))
            : (rawInfo ?? Buffer.alloc(0));
        return Buffer.concat([u2(addUtf8(attribute.name)), u4(info.length), info]);
      })
    ]);
  };

  const encodeMembers = (members: ClassMemberSpec[] = []): Buffer => {
    return Buffer.concat([
      u2(members.length),
      ...members.map((member) =>
        Buffer.concat([
          u2(member.accessFlags ?? 0),
          u2(addUtf8(member.name)),
          u2(addUtf8(member.descriptor)),
          encodeAttributes(member.attributes)
        ])
      )
    ]);
  };

  return Buffer.concat([
    u4(0xcafebabe),
    u2(0),
    u2(61),
    u2(constantPool.length + 1),
    ...constantPool,
    u2(spec.accessFlags ?? 0x0021),
    u2(thisClassIndex),
    u2(superClassIndex),
    u2(interfaceIndexes.length),
    ...interfaceIndexes.map((index) => u2(index)),
    encodeMembers(spec.fields),
    encodeMembers(spec.methods),
    encodeAttributes(spec.attributes)
  ]);
}
