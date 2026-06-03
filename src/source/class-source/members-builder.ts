import type { SignatureMember } from "../../minecraft-explorer-service.js";
import type { SourceService } from "../../source-service.js";
import type { MappingSourcePriority, SourceMapping } from "../../types.js";

export type RemappedMembers = {
  constructors: SignatureMember[];
  fields: SignatureMember[];
  methods: SignatureMember[];
  counts: {
    constructors: number;
    fields: number;
    methods: number;
    total: number;
  };
};

export type RemapMembersInput = {
  signatureConstructors: SignatureMember[];
  signatureFields: SignatureMember[];
  signatureMethods: SignatureMember[];
  version: string | undefined;
  mappingApplied: SourceMapping;
  requestedMapping: SourceMapping;
  sourcePriority: MappingSourcePriority | undefined;
  gradleUserHome?: string;
  memberPattern: string | undefined;
  warnings: string[];
};

export async function remapAndCountMembers(
  svc: SourceService,
  input: RemapMembersInput
): Promise<RemappedMembers> {
  const remap = async (members: SignatureMember[], kind: "field" | "method"): Promise<SignatureMember[]> => {
    if (input.version == null) {
      return members;
    }
    const result = await svc.remapSignatureMembers(
      members,
      kind,
      input.version,
      input.mappingApplied,
      input.requestedMapping,
      input.sourcePriority,
      input.warnings,
      undefined,
      input.gradleUserHome
    );
    return result.members;
  };

  let constructors = await remap(input.signatureConstructors, "method");
  let fields = await remap(input.signatureFields, "field");
  let methods = await remap(input.signatureMethods, "method");

  if (input.requestedMapping !== input.mappingApplied && input.memberPattern) {
    const lowerPattern = input.memberPattern.toLowerCase();
    constructors = constructors.filter((m) => m.name.toLowerCase().includes(lowerPattern));
    fields = fields.filter((m) => m.name.toLowerCase().includes(lowerPattern));
    methods = methods.filter((m) => m.name.toLowerCase().includes(lowerPattern));
  }

  const counts = {
    constructors: constructors.length,
    fields: fields.length,
    methods: methods.length,
    total: constructors.length + fields.length + methods.length
  };

  return { constructors, fields, methods, counts };
}

export type MemberSliceResult = {
  constructors: SignatureMember[];
  fields: SignatureMember[];
  methods: SignatureMember[];
  truncated: boolean;
  returnedTotal: number;
  /** Absolute offset to resume from when more members remain after this page. */
  nextOffset?: number;
};

export function sliceMembersWithLimit(
  remapped: Omit<RemappedMembers, "counts">,
  totalCount: number,
  maxMembers: number,
  warnings: string[],
  offset = 0
): MemberSliceResult {
  // Members form a single flat sequence in [constructors, fields, methods]
  // order; offset skips that many from the start before taking maxMembers.
  let toSkip = Math.max(0, offset);
  let remaining = maxMembers;
  const takeWithinLimit = (members: SignatureMember[]): SignatureMember[] => {
    if (toSkip >= members.length) {
      toSkip -= members.length;
      return [];
    }
    const afterSkip = toSkip > 0 ? members.slice(toSkip) : members;
    toSkip = 0;
    if (remaining <= 0) {
      return [];
    }
    const slice = afterSkip.slice(0, remaining);
    remaining -= slice.length;
    return slice;
  };

  const constructors = takeWithinLimit(remapped.constructors);
  const fields = takeWithinLimit(remapped.fields);
  const methods = takeWithinLimit(remapped.methods);
  const returnedTotal = constructors.length + fields.length + methods.length;
  const consumed = Math.min(Math.max(0, offset), totalCount) + returnedTotal;
  const truncated = consumed < totalCount;
  if (truncated) {
    warnings.push(`Member list was truncated to ${returnedTotal} entries (from ${totalCount}).`);
  }

  return {
    constructors,
    fields,
    methods,
    truncated,
    returnedTotal,
    ...(truncated ? { nextOffset: consumed } : {})
  };
}

/** Slim per-member wire shape: only what an agent reading Java needs. */
export type WireMember = {
  name: string;
  javaSignature: string;
  /**
   * JVM descriptor. Always present on methods/constructors (overload
   * disambiguation for @At/@Shadow matching); omitted on FIELD members by
   * default (the single type is already in javaSignature) unless
   * keepFieldDescriptors is set.
   */
  jvmDescriptor?: string;
  /** Present only when members span multiple owners (includeInherited). */
  ownerFqn?: string;
  /** Present only when true. */
  isSynthetic?: boolean;
};

export type WireMembersBlock = {
  /** Hoisted owner when every member shares one owner (the common, non-inherited case). */
  ownerFqn?: string;
  constructors: WireMember[];
  fields: WireMember[];
  methods: WireMember[];
};

/**
 * Project the internal six-field SignatureMember arrays to the slim wire shape.
 * `ownerFqn` is hoisted to the block level when all members share a single owner
 * (so it is not repeated per member); when members span multiple owners — the
 * includeInherited case — it stays per member and the block-level field is omitted.
 * `accessFlags` is dropped (javaSignature already encodes the modifiers);
 * `isSynthetic` is emitted only when true. `jvmDescriptor` is always kept on
 * methods/constructors (overload disambiguation) and, on FIELD members, only when
 * keepFieldDescriptors is set (the field's single type is already in javaSignature).
 *
 * The owner anchor is derived from the members themselves (not from the looked-up
 * class name) so it is correct in the requested namespace regardless of remapping.
 */
export function projectMembersForWire(
  slice: { constructors: SignatureMember[]; fields: SignatureMember[]; methods: SignatureMember[] },
  includeInherited: boolean,
  keepFieldDescriptors = false
): WireMembersBlock {
  const owners = new Set(
    [...slice.constructors, ...slice.fields, ...slice.methods].map((m) => m.ownerFqn)
  );
  const hoistOwner = !includeInherited && owners.size === 1;
  const toWire = (m: SignatureMember, keepDescriptor: boolean): WireMember => ({
    name: m.name,
    javaSignature: m.javaSignature,
    ...(keepDescriptor ? { jvmDescriptor: m.jvmDescriptor } : {}),
    ...(hoistOwner ? {} : { ownerFqn: m.ownerFqn }),
    ...(m.isSynthetic ? { isSynthetic: true } : {})
  });
  return {
    ...(hoistOwner ? { ownerFqn: [...owners][0]! } : {}),
    constructors: slice.constructors.map((m) => toWire(m, true)),
    fields: slice.fields.map((m) => toWire(m, keepFieldDescriptors)),
    methods: slice.methods.map((m) => toWire(m, true))
  };
}
