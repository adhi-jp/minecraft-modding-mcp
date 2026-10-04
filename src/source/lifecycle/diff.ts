import { ERROR_CODES, createError, isAppError } from "../../errors.js";
import { reportedNamespace } from "../../mapping-pipeline-service.js";
import type { SignatureMember } from "../../minecraft-explorer-service.js";
import type {
  DiffClassChange,
  DiffClassMemberDelta,
  DiffClassSignaturesInput,
  DiffClassSignaturesOutput,
  SourceService
} from "../../source-service.js";
import { isUnobfuscatedVersion } from "../../version-service.js";
import {
  compactDiffDelta,
  diffMembersByKey,
  emptyDiffDelta,
  sortDiffMembers
} from "./diff-utils.js";
import { normalizeMapping } from "../shared-utils.js";
import { resolveToObfuscatedClassName } from "./mapping-helpers.js";
import { resolveManifestRange } from "./range.js";

type SignatureSnapshot = {
  constructors: SignatureMember[];
  fields: SignatureMember[];
  methods: SignatureMember[];
  warnings: string[];
};

export async function diffClassSignatures(svc: SourceService, input: DiffClassSignaturesInput): Promise<DiffClassSignaturesOutput> {
  const className = input.className.trim();
  const fromVersion = input.fromVersion.trim();
  const toVersion = input.toVersion.trim();
  const includeFullDiff = input.includeFullDiff ?? true;
  if (!className || !fromVersion || !toVersion) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "className, fromVersion, and toVersion must be non-empty strings.",
      details: {
        className: input.className,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion
      }
    });
  }

  const mapping = normalizeMapping(input.mapping);

  await resolveManifestRange(svc, { fromVersion, toVersion });

  const mappingWarnings: string[] = [];
  const obfuscatedFromClassName = await resolveToObfuscatedClassName(
    svc,
    className,
    fromVersion,
    mapping,
    input.sourcePriority,
    mappingWarnings,
    input.gradleUserHome
  );
  const obfuscatedToClassName =
    fromVersion === toVersion
      ? obfuscatedFromClassName
      : await resolveToObfuscatedClassName(
          svc,
          className,
          toVersion,
          mapping,
          input.sourcePriority,
          mappingWarnings,
          input.gradleUserHome
        );

  const [fromResolved, toResolved] = await Promise.all([
    svc.versionService.resolveVersionJar(fromVersion),
    svc.versionService.resolveVersionJar(toVersion)
  ]);

  const loadSignature = async (
    version: string,
    jarPath: string,
    obfuscatedClassName: string
  ): Promise<SignatureSnapshot | undefined> => {
    try {
      const signature = await svc.explorerService.getSignature({
        fqn: obfuscatedClassName,
        jarPath,
        access: "all",
        includeSynthetic: false,
        includeInherited: false
      });
      return {
        constructors: signature.constructors,
        fields: signature.fields,
        methods: signature.methods,
        warnings: signature.warnings
      };
    } catch (caughtError) {
      if (isAppError(caughtError) && caughtError.code === ERROR_CODES.CLASS_NOT_FOUND) {
        return undefined;
      }
      throw caughtError;
    }
  };

  const [fromSignature, toSignature] = await Promise.all([
    loadSignature(fromVersion, fromResolved.jarPath, obfuscatedFromClassName),
    loadSignature(toVersion, toResolved.jarPath, obfuscatedToClassName)
  ]);

  const warnings: string[] = [...mappingWarnings];
  if (fromSignature) {
    warnings.push(...fromSignature.warnings.map((warning) => `[${fromVersion}] ${warning}`));
  }
  if (toSignature) {
    warnings.push(...toSignature.warnings.map((warning) => `[${toVersion}] ${warning}`));
  }

  let classChange: DiffClassChange = "present_in_both";
  if (!fromSignature && !toSignature) {
    classChange = "absent_in_both";
    warnings.push(`Class "${className}" was not found in both versions.`);
  } else if (!fromSignature) {
    classChange = "added";
  } else if (!toSignature) {
    classChange = "removed";
  }

  const fromMembers = fromSignature ?? {
    constructors: [],
    fields: [],
    methods: [],
    warnings: []
  };
  const toMembers = toSignature ?? {
    constructors: [],
    fields: [],
    methods: [],
    warnings: []
  };

  const constructors = buildMemberDelta(
    classChange,
    fromMembers.constructors,
    toMembers.constructors,
    (member) => member.jvmDescriptor,
    false
  );
  const methods = buildMemberDelta(
    classChange,
    fromMembers.methods,
    toMembers.methods,
    (member) => `${member.name}#${member.jvmDescriptor}`,
    false
  );
  const fields = buildMemberDelta(classChange, fromMembers.fields, toMembers.fields, (member) => member.name, true);

  // Remap diff delta members for non-obfuscated mappings
  // One remap call per version side, so remap-failure warnings aggregate across
  // added/removed and modified members instead of one line per modified member.
  const remapDelta = async (
    delta: DiffClassMemberDelta,
    kind: "field" | "method"
  ): Promise<DiffClassMemberDelta> => {
    const modifiedPairs = delta.modified.map((change) => {
      if (!change.from || !change.to) {
        throw createError({
          code: ERROR_CODES.INTERNAL,
          message: "Modified diff members are missing before remap.",
          details: {
            key: change.key,
            kind,
            fromVersion,
            toVersion,
            mapping
          }
        });
      }
      return { from: change.from, to: change.to };
    });
    const [fromSide, toSide] = await Promise.all([
      svc.remapSignatureMembers(
        [...delta.removed, ...modifiedPairs.map((pair) => pair.from)],
        kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings, undefined, input.gradleUserHome
      ),
      svc.remapSignatureMembers(
        [...delta.added, ...modifiedPairs.map((pair) => pair.to)],
        kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings, undefined, input.gradleUserHome
      )
    ]);
    const remappedModified = delta.modified.map((change, index) => {
      const fromMember = fromSide.members[delta.removed.length + index];
      const toMember = toSide.members[delta.added.length + index];
      if (!fromMember || !toMember) {
        throw createError({
          code: ERROR_CODES.INTERNAL,
          message: "Failed to remap modified diff members.",
          details: {
            key: change.key,
            kind,
            fromVersion,
            toVersion,
            mapping
          }
        });
      }
      return { ...change, from: fromMember, to: toMember };
    });
    return {
      added: toSide.members.slice(0, delta.added.length),
      removed: fromSide.members.slice(0, delta.removed.length),
      modified: remappedModified
    };
  };

  const [remappedConstructors, remappedMethods, remappedFields] = await Promise.all([
    remapDelta(constructors, "method"),
    remapDelta(methods, "method"),
    remapDelta(fields, "field")
  ]);

  const constructorCounts = countDelta(remappedConstructors);
  const methodCounts = countDelta(remappedMethods);
  const fieldCounts = countDelta(remappedFields);
  const summary = {
    constructors: constructorCounts,
    methods: methodCounts,
    fields: fieldCounts,
    total: {
      added: constructorCounts.added + methodCounts.added + fieldCounts.added,
      removed: constructorCounts.removed + methodCounts.removed + fieldCounts.removed,
      modified: constructorCounts.modified + methodCounts.modified + fieldCounts.modified
    }
  };

  return {
    query: {
      className,
      fromVersion,
      toVersion,
      // A mixed-era or all-legacy comparison keeps the label it always had.
      mapping: reportedNamespace(
        mapping,
        isUnobfuscatedVersion(fromVersion) && isUnobfuscatedVersion(toVersion)
      )
    },
    range: {
      fromVersion,
      toVersion
    },
    classChange,
    constructors: includeFullDiff ? remappedConstructors : compactDiffDelta(remappedConstructors),
    methods: includeFullDiff ? remappedMethods : compactDiffDelta(remappedMethods),
    fields: includeFullDiff ? remappedFields : compactDiffDelta(remappedFields),
    summary,
    warnings
  };
}

/** The member delta for one member kind, given how the class itself changed. */
function buildMemberDelta(
  classChange: DiffClassChange,
  fromList: SignatureMember[],
  toList: SignatureMember[],
  keyFn: (member: SignatureMember) => string,
  includeDescriptor: boolean
): DiffClassMemberDelta {
  if (classChange === "added") {
    return { added: sortDiffMembers(toList), removed: [], modified: [] };
  }
  if (classChange === "removed") {
    return { added: [], removed: sortDiffMembers(fromList), modified: [] };
  }
  if (classChange === "absent_in_both") {
    return emptyDiffDelta();
  }
  return diffMembersByKey(fromList, toList, keyFn, includeDescriptor);
}

function countDelta(delta: DiffClassMemberDelta): { added: number; removed: number; modified: number } {
  return { added: delta.added.length, removed: delta.removed.length, modified: delta.modified.length };
}
