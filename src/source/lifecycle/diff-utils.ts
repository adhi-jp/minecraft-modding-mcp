import type {
  DiffClassMemberDelta,
  DiffMember,
  DiffMemberChange
} from "../../source-service.js";

type DiffMemberChangedField = "accessFlags" | "isSynthetic" | "javaSignature" | "jvmDescriptor";

export function sortDiffMembers(members: DiffMember[]): DiffMember[] {
  return [...members].sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    const descriptorCompare = left.jvmDescriptor.localeCompare(right.jvmDescriptor);
    if (descriptorCompare !== 0) {
      return descriptorCompare;
    }

    return left.ownerFqn.localeCompare(right.ownerFqn);
  });
}

export function sortDiffMemberChanges(changes: DiffMemberChange[]): DiffMemberChange[] {
  return [...changes].sort((left, right) => {
    const keyCompare = left.key.localeCompare(right.key);
    if (keyCompare !== 0) {
      return keyCompare;
    }

    const fromOwnerCompare = (left.from?.ownerFqn ?? "").localeCompare(right.from?.ownerFqn ?? "");
    if (fromOwnerCompare !== 0) {
      return fromOwnerCompare;
    }

    return (left.to?.ownerFqn ?? "").localeCompare(right.to?.ownerFqn ?? "");
  });
}

export function changedMemberFields(
  fromMember: DiffMember,
  toMember: DiffMember,
  includeDescriptor: boolean
): DiffMemberChangedField[] {
  const changed: DiffMemberChangedField[] = [];

  if (fromMember.accessFlags !== toMember.accessFlags) {
    changed.push("accessFlags");
  }
  if (fromMember.isSynthetic !== toMember.isSynthetic) {
    changed.push("isSynthetic");
  }
  if (fromMember.javaSignature !== toMember.javaSignature) {
    changed.push("javaSignature");
  }
  if (includeDescriptor && fromMember.jvmDescriptor !== toMember.jvmDescriptor) {
    changed.push("jvmDescriptor");
  }

  return changed;
}

export function diffMembersByKey(
  fromMembersInput: DiffMember[],
  toMembersInput: DiffMember[],
  buildKey: (member: DiffMember) => string,
  includeDescriptorInModified: boolean
): DiffClassMemberDelta {
  const fromMembers = sortDiffMembers(fromMembersInput);
  const toMembers = sortDiffMembers(toMembersInput);
  const fromByKey = new Map<string, DiffMember>();
  const toByKey = new Map<string, DiffMember>();

  for (const member of fromMembers) {
    const key = buildKey(member);
    if (!fromByKey.has(key)) {
      fromByKey.set(key, member);
    }
  }
  for (const member of toMembers) {
    const key = buildKey(member);
    if (!toByKey.has(key)) {
      toByKey.set(key, member);
    }
  }

  const added: DiffMember[] = [];
  const removed: DiffMember[] = [];
  const modified: DiffMemberChange[] = [];

  for (const [key, toMember] of toByKey.entries()) {
    const fromMember = fromByKey.get(key);
    if (!fromMember) {
      added.push(toMember);
      continue;
    }

    const changed = changedMemberFields(fromMember, toMember, includeDescriptorInModified);
    if (changed.length > 0) {
      modified.push({
        key,
        from: fromMember,
        to: toMember,
        changed
      });
    }
  }

  for (const [key, fromMember] of fromByKey.entries()) {
    if (!toByKey.has(key)) {
      removed.push(fromMember);
    }
  }

  return {
    added: sortDiffMembers(added),
    removed: sortDiffMembers(removed),
    modified: sortDiffMemberChanges(modified)
  };
}

export function emptyDiffDelta(): DiffClassMemberDelta {
  return {
    added: [],
    removed: [],
    modified: []
  };
}

export function compactDiffDelta(delta: DiffClassMemberDelta): DiffClassMemberDelta {
  return {
    added: delta.added,
    removed: delta.removed,
    modified: delta.modified.map((change) => ({
      key: change.key,
      changed: [...change.changed]
    }))
  };
}
