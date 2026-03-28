export type AccessTransformerAccessAction =
  | "public"
  | "protected"
  | "package-private"
  | "private";

export type AccessTransformerFinalAction = "add" | "remove";

export type AccessTransformerEntry = {
  line: number;
  targetKind: "class" | "field" | "method";
  owner: string;
  target: string;
  name?: string;
  descriptor?: string;
  accessAction: AccessTransformerAccessAction;
  finalAction?: AccessTransformerFinalAction;
};

export type ParsedAccessTransformer = {
  entries: AccessTransformerEntry[];
  parseWarnings: string[];
};

function parseAccessDeclaration(raw: string): {
  accessAction: AccessTransformerAccessAction;
  finalAction?: AccessTransformerFinalAction;
} | undefined {
  const match = raw.match(/^(public|protected|default|private)([+-]f)?$/i);
  if (!match) {
    return undefined;
  }

  const finalModifier = match[2]?.toLowerCase();

  return {
    accessAction:
      match[1]?.toLowerCase() === "default"
        ? "package-private"
        : (match[1]?.toLowerCase() as AccessTransformerAccessAction),
    ...(finalModifier === "+f" ? { finalAction: "add" as const } : {}),
    ...(finalModifier === "-f" ? { finalAction: "remove" as const } : {})
  };
}

function splitMemberToken(tokens: string[]): {
  name?: string;
  descriptor?: string;
  targetKind: "class" | "field" | "method";
} {
  if (tokens.length === 0) {
    return { targetKind: "class" };
  }

  if (tokens.length === 1) {
    const token = tokens[0] ?? "";
    const descriptorStart = token.indexOf("(");
    if (descriptorStart >= 0) {
      return {
        targetKind: "method",
        name: token.slice(0, descriptorStart),
        descriptor: token.slice(descriptorStart)
      };
    }
    return {
      targetKind: "field",
      name: token
    };
  }

  return {
    targetKind: "method",
    name: tokens[0],
    descriptor: tokens.slice(1).join("")
  };
}

export function parseAccessTransformer(content: string): ParsedAccessTransformer {
  const entries: AccessTransformerEntry[] = [];
  const parseWarnings: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const rawLine = (lines[index] ?? "").trim();
    if (!rawLine || rawLine.startsWith("#")) {
      continue;
    }
    const withoutComment = rawLine.replace(/\s+#.*$/, "").trim();
    if (!withoutComment) {
      continue;
    }

    const parts = withoutComment.split(/\s+/);
    if (parts.length < 2) {
      parseWarnings.push(`Line ${lineNumber}: Incomplete access transformer entry "${withoutComment}".`);
      continue;
    }

    const declaration = parseAccessDeclaration(parts[0] ?? "");
    if (!declaration) {
      parseWarnings.push(`Line ${lineNumber}: Unsupported access declaration "${parts[0]}".`);
      continue;
    }

    const owner = parts[1] ?? "";
    if (!owner) {
      parseWarnings.push(`Line ${lineNumber}: Incomplete access transformer entry "${withoutComment}".`);
      continue;
    }

    const member = splitMemberToken(parts.slice(2));
    if (member.targetKind === "method" && (!member.name || !member.descriptor)) {
      parseWarnings.push(`Line ${lineNumber}: Method entry requires a method name and JVM descriptor.`);
      continue;
    }
    if ((member.targetKind === "field" || member.targetKind === "method") && !member.name) {
      parseWarnings.push(`Line ${lineNumber}: Member entry requires a target name.`);
      continue;
    }

    const target =
      member.targetKind === "class"
        ? owner
        : `${owner}#${member.name}${member.descriptor ?? ""}`;

    entries.push({
      line: lineNumber,
      owner,
      target,
      targetKind: member.targetKind,
      ...(member.name ? { name: member.name } : {}),
      ...(member.descriptor ? { descriptor: member.descriptor } : {}),
      accessAction: declaration.accessAction,
      ...(declaration.finalAction ? { finalAction: declaration.finalAction } : {})
    });
  }

  return {
    entries,
    parseWarnings
  };
}
