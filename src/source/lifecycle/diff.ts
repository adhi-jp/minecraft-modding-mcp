import { buildSuggestedCall } from "../../build-suggested-call.js";
import { ERROR_CODES, createError, isAppError } from "../../errors.js";
import type { SignatureMember } from "../../minecraft-explorer-service.js";
import type {
  DiffClassMemberDelta,
  DiffClassSignaturesInput,
  DiffClassSignaturesOutput,
  SourceService
} from "../../source-service.js";
import {
  compactDiffDelta,
  diffMembersByKey,
  emptyDiffDelta,
  sortDiffMembers
} from "./diff-utils.js";
import {
  normalizeMapping,
  resolveToObfuscatedClassName
} from "./mapping-helpers.js";

type DiffClassChange = "added" | "removed" | "present_in_both" | "absent_in_both";

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

  const manifestOrder = await svc.versionService.listVersionIds();
  if (manifestOrder.length === 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: "No Minecraft versions were returned by manifest.",
      details: {
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }

  const chronological = [...manifestOrder].reverse();
  const fromIndex = chronological.indexOf(fromVersion);
  const toIndex = chronological.indexOf(toVersion);

  if (fromIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `fromVersion "${fromVersion}" was not found in manifest.`,
      details: {
        fromVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (toIndex < 0) {
    throw createError({
      code: ERROR_CODES.VERSION_NOT_FOUND,
      message: `toVersion "${toVersion}" was not found in manifest.`,
      details: {
        toVersion,
        nextAction: "Use list-versions to see available Minecraft versions.",
        ...buildSuggestedCall({ tool: "list-versions", params: {} })
      }
    });
  }
  if (fromIndex > toIndex) {
    throw createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "fromVersion must be older than or equal to toVersion.",
      details: { fromVersion, toVersion }
    });
  }

  const mappingWarnings: string[] = [];
  const obfuscatedFromClassName = await resolveToObfuscatedClassName(
    svc,
    className,
    fromVersion,
    mapping,
    input.sourcePriority,
    mappingWarnings
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
          mappingWarnings
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

  const constructors =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.constructors),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.constructors),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(fromMembers.constructors, toMembers.constructors, (member) => member.jvmDescriptor, false);

  const methods =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.methods),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.methods),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(
              fromMembers.methods,
              toMembers.methods,
              (member) => `${member.name}#${member.jvmDescriptor}`,
              false
            );

  const fields =
    classChange === "added"
      ? {
          added: sortDiffMembers(toMembers.fields),
          removed: [],
          modified: []
        }
      : classChange === "removed"
        ? {
            added: [],
            removed: sortDiffMembers(fromMembers.fields),
            modified: []
          }
        : classChange === "absent_in_both"
          ? emptyDiffDelta()
          : diffMembersByKey(fromMembers.fields, toMembers.fields, (member) => member.name, true);

  // Remap diff delta members for non-obfuscated mappings
  const remapDelta = async (
    delta: DiffClassMemberDelta,
    kind: "field" | "method"
  ): Promise<DiffClassMemberDelta> => {
    const [addedResult, removedResult] = await Promise.all([
      svc.remapSignatureMembers(delta.added, kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings),
      svc.remapSignatureMembers(delta.removed, kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings)
    ]);
    const remappedModified = await Promise.all(
      delta.modified.map(async (change) => {
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
        const [fromResult, toResult] = await Promise.all([
          svc.remapSignatureMembers([change.from], kind, fromVersion, "obfuscated", mapping, input.sourcePriority, warnings),
          svc.remapSignatureMembers([change.to], kind, toVersion, "obfuscated", mapping, input.sourcePriority, warnings)
        ]);
        const fromMember = fromResult.members[0];
        const toMember = toResult.members[0];
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
      })
    );
    return { added: addedResult.members, removed: removedResult.members, modified: remappedModified };
  };

  const [remappedConstructors, remappedMethods, remappedFields] = await Promise.all([
    remapDelta(constructors, "method"),
    remapDelta(methods, "method"),
    remapDelta(fields, "field")
  ]);

  const summary = {
    constructors: {
      added: remappedConstructors.added.length,
      removed: remappedConstructors.removed.length,
      modified: remappedConstructors.modified.length
    },
    methods: {
      added: remappedMethods.added.length,
      removed: remappedMethods.removed.length,
      modified: remappedMethods.modified.length
    },
    fields: {
      added: remappedFields.added.length,
      removed: remappedFields.removed.length,
      modified: remappedFields.modified.length
    },
    total: {
      added: remappedConstructors.added.length + remappedMethods.added.length + remappedFields.added.length,
      removed: remappedConstructors.removed.length + remappedMethods.removed.length + remappedFields.removed.length,
      modified: remappedConstructors.modified.length + remappedMethods.modified.length + remappedFields.modified.length
    }
  };

  return {
    query: {
      className,
      fromVersion,
      toVersion,
      mapping
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
