/**
 * Lightweight regex-based parser for Fabric Mixin Java sources.
 * No AST required — pattern-matches annotations and member declarations.
 */

export type ParsedMixinTarget = {
  className: string;
};

export type ParsedInjection = {
  annotation: string;
  method: string;
  line: number;
};

export type ParsedShadow = {
  kind: "field" | "method";
  name: string;
  descriptor?: string;
  line: number;
};

export type ParsedAccessor = {
  annotation: "Accessor" | "Invoker";
  name: string;
  targetName: string;
  line: number;
};

export type ParsedMixin = {
  className: string;
  targets: ParsedMixinTarget[];
  priority?: number;
  injections: ParsedInjection[];
  shadows: ParsedShadow[];
  accessors: ParsedAccessor[];
  parseWarnings: string[];
};

/* ------------------------------------------------------------------ */
/*  Regex patterns                                                     */
/* ------------------------------------------------------------------ */

const CLASS_DECL_RE = /(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/;

// @Mixin(Foo.class)  or  @Mixin({Foo.class, Bar.class})  or  @Mixin(value = Foo.class)
// Also handles  @Mixin(value = {Foo.class, Bar.class}, priority = 900)
const MIXIN_ANNOTATION_START_RE = /^\s*@Mixin\s*\(/;
const MIXIN_TARGET_RE = /(\w[\w.]*?)\.class/g;
const MIXIN_PRIORITY_RE = /priority\s*=\s*(\d+)/;

// Injection annotations: @Inject, @Redirect, @ModifyArg, @ModifyVariable, @ModifyConstant, @ModifyExpressionValue
const INJECTION_ANNOTATION_RE =
  /^\s*@(Inject|Redirect|ModifyArg|ModifyVariable|ModifyConstant|ModifyExpressionValue)\s*\(/;
const METHOD_ATTR_RE = /method\s*=\s*"([^"]+)"/;

// @Shadow field / method
const SHADOW_ANNOTATION_RE = /^\s*@Shadow\b/;
const FIELD_DECL_RE =
  /(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?(\w[\w<>,\s]*?)\s+(\w+)\s*[;=]/;
const METHOD_DECL_RE =
  /(?:private|protected|public)?\s*(?:static\s+)?(?:abstract\s+)?(?:native\s+)?(\w[\w<>,\s]*?)\s+(\w+)\s*\(/;

// @Accessor / @Invoker
const ACCESSOR_ANNOTATION_RE = /^\s*@(Accessor|Invoker)\s*(?:\(\s*"([^"]+)"\s*\))?\s*$/;
const ACCESSOR_ANNOTATION_START_RE = /^\s*@(Accessor|Invoker)\s*\(/;
const ACCESSOR_EXPLICIT_RE = /"([^"]+)"/;

// Naming conventions for accessor/invoker target inference
const GETTER_PREFIX_RE = /^(?:get|is)([A-Z].*)/;
const SETTER_PREFIX_RE = /^set([A-Z].*)/;
const INVOKER_PREFIX_RE = /^(?:invoke|call)([A-Z].*)/;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function collectMultilineAnnotation(lines: string[], startIndex: number): { text: string; endIndex: number } {
  let depth = 0;
  let text = "";
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    text += (i === startIndex ? "" : "\n") + line;
    for (const ch of line) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
    }
    if (depth <= 0) {
      return { text, endIndex: i };
    }
  }
  return { text, endIndex: lines.length - 1 };
}

function inferAccessorTarget(methodName: string): string {
  const getterMatch = GETTER_PREFIX_RE.exec(methodName);
  if (getterMatch) {
    return getterMatch[1].charAt(0).toLowerCase() + getterMatch[1].slice(1);
  }
  const setterMatch = SETTER_PREFIX_RE.exec(methodName);
  if (setterMatch) {
    return setterMatch[1].charAt(0).toLowerCase() + setterMatch[1].slice(1);
  }
  const invokerMatch = INVOKER_PREFIX_RE.exec(methodName);
  if (invokerMatch) {
    return invokerMatch[1].charAt(0).toLowerCase() + invokerMatch[1].slice(1);
  }
  return methodName;
}

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

export function parseMixinSource(source: string): ParsedMixin {
  const lines = source.split(/\r?\n/);
  const parseWarnings: string[] = [];
  const targets: ParsedMixinTarget[] = [];
  const injections: ParsedInjection[] = [];
  const shadows: ParsedShadow[] = [];
  const accessors: ParsedAccessor[] = [];
  let className = "";
  let priority: number | undefined;

  // --- Pass 1: find @Mixin annotation and class name ---
  let i = 0;
  while (i < lines.length) {
    if (MIXIN_ANNOTATION_START_RE.test(lines[i])) {
      const { text: mixinText, endIndex } = collectMultilineAnnotation(lines, i);
      MIXIN_TARGET_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MIXIN_TARGET_RE.exec(mixinText)) !== null) {
        targets.push({ className: match[1] });
      }
      const priorityMatch = MIXIN_PRIORITY_RE.exec(mixinText);
      if (priorityMatch) {
        priority = parseInt(priorityMatch[1], 10);
      }
      i = endIndex + 1;
      continue;
    }

    const classMatch = CLASS_DECL_RE.exec(lines[i]);
    if (classMatch && !className) {
      className = classMatch[1];
    }
    i++;
  }

  if (targets.length === 0) {
    parseWarnings.push("No @Mixin annotation target found.");
  }

  // --- Pass 2: scan member annotations ---
  i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNum = i + 1;

    // --- @Inject / @Redirect / @ModifyArg etc. ---
    const injMatch = INJECTION_ANNOTATION_RE.exec(line);
    if (injMatch) {
      const annotation = injMatch[1];
      const { text: fullAnnotation, endIndex } = collectMultilineAnnotation(lines, i);
      const methodMatch = METHOD_ATTR_RE.exec(fullAnnotation);
      if (methodMatch) {
        injections.push({ annotation, method: methodMatch[1], line: lineNum });
      } else {
        parseWarnings.push(`Line ${lineNum}: @${annotation} missing method attribute.`);
      }
      i = endIndex + 1;
      continue;
    }

    // --- @Shadow ---
    if (SHADOW_ANNOTATION_RE.test(line)) {
      // Advance past @Shadow line to find the declaration
      let declLine = i + 1;
      // Skip additional annotations between @Shadow and declaration
      while (declLine < lines.length && /^\s*@/.test(lines[declLine])) {
        declLine++;
      }
      if (declLine < lines.length) {
        const declText = lines[declLine];
        const methodDeclMatch = METHOD_DECL_RE.exec(declText);
        const fieldDeclMatch = FIELD_DECL_RE.exec(declText);
        // Method if it has parentheses
        if (declText.includes("(") && methodDeclMatch) {
          shadows.push({ kind: "method", name: methodDeclMatch[2], line: lineNum });
        } else if (fieldDeclMatch) {
          shadows.push({ kind: "field", name: fieldDeclMatch[2], line: lineNum });
        } else {
          parseWarnings.push(`Line ${lineNum}: Could not parse @Shadow member declaration.`);
        }
      }
      i = declLine + 1;
      continue;
    }

    // --- @Accessor / @Invoker ---
    const accessorMatch = ACCESSOR_ANNOTATION_RE.exec(line);
    const accessorStartMatch = !accessorMatch ? ACCESSOR_ANNOTATION_START_RE.exec(line) : null;
    if (accessorMatch || accessorStartMatch) {
      const annotation = (accessorMatch?.[1] ?? accessorStartMatch?.[1]) as "Accessor" | "Invoker";
      let explicitTarget = accessorMatch?.[2];

      if (!explicitTarget && accessorStartMatch) {
        const { text: fullAnnotation, endIndex } = collectMultilineAnnotation(lines, i);
        const explicitMatch = ACCESSOR_EXPLICIT_RE.exec(fullAnnotation);
        if (explicitMatch) {
          explicitTarget = explicitMatch[1];
        }
        i = endIndex;
      }

      // Find the method declaration following the annotation
      let methodLine = i + 1;
      while (methodLine < lines.length && /^\s*@/.test(lines[methodLine])) {
        methodLine++;
      }
      if (methodLine < lines.length) {
        const methodDeclMatch = METHOD_DECL_RE.exec(lines[methodLine]);
        if (methodDeclMatch) {
          const methodName = methodDeclMatch[2];
          const targetName = explicitTarget ?? inferAccessorTarget(methodName);
          accessors.push({ annotation, name: methodName, targetName, line: lineNum });
        } else {
          parseWarnings.push(`Line ${lineNum}: Could not parse @${annotation} method declaration.`);
        }
      }
      i = methodLine + 1;
      continue;
    }

    i++;
  }

  return {
    className,
    targets,
    priority,
    injections,
    shadows,
    accessors,
    parseWarnings
  };
}
