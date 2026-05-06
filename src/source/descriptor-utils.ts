/**
 * Pure descriptor / signature helpers used by SourceService when remapping
 * member metadata across mapping namespaces. Behavior-preserving extraction
 * from the tail of `src/source-service.ts`.
 */

import {
  modifierPrefix,
  parseFieldType,
  parseMethodDescriptor
} from "../minecraft-explorer-service.js";

export function remapJvmDescriptor(descriptor: string, classMap: Map<string, string>): string {
  if (classMap.size === 0) {
    return descriptor;
  }
  return descriptor.replace(/L([^;]+);/g, (match, ref: string) => {
    const dotFqn = ref.replace(/\//g, ".");
    const remapped = classMap.get(dotFqn);
    return remapped ? `L${remapped.replace(/\./g, "/")};` : match;
  });
}

export function rebuildJavaSignature(
  member: { name: string; ownerFqn: string; accessFlags: number },
  remappedDescriptor: string,
  isField: boolean
): string {
  const modifiers = modifierPrefix(member.accessFlags, isField ? "field" : "method");
  const prefix = modifiers ? `${modifiers} ` : "";
  if (isField) {
    try {
      const { type } = parseFieldType(remappedDescriptor, 0, { allowVoid: false });
      return `${prefix}${type} ${member.name}`.trim();
    } catch {
      return `${prefix}${member.name}`.trim();
    }
  }
  try {
    const { args, returnType } = parseMethodDescriptor(remappedDescriptor);
    const argStr = args.join(", ");
    if (member.name === "<init>") {
      const ownerSimple = member.ownerFqn.split(".").pop()!;
      return `${prefix}${ownerSimple}(${argStr})`.trim();
    }
    return `${prefix}${returnType} ${member.name}(${argStr})`.trim();
  } catch {
    return `${prefix}${member.name}`.trim();
  }
}
