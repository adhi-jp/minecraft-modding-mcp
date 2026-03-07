interface AttributeSpec {
  name: string;
  info?: Buffer;
}

export interface ClassMemberSpec {
  name: string;
  descriptor: string;
  accessFlags?: number;
  attributes?: AttributeSpec[];
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

  const preloadAttributes = (attributes: AttributeSpec[] = []): void => {
    for (const attribute of attributes) {
      addUtf8(attribute.name);
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
        const info = attribute.info ?? Buffer.alloc(0);
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
