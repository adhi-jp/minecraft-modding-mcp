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
  imports: Map<string, string>;
  injections: ParsedInjection[];
  shadows: ParsedShadow[];
  accessors: ParsedAccessor[];
  parseWarnings: string[];
};

/* ------------------------------------------------------------------ */
/*  Regex patterns                                                     */
/* ------------------------------------------------------------------ */

const CLASS_DECL_RE = /(?:public\s+)?(?:abstract\s+)?(?:class|interface)\s+(\w+)/;

// import statements for FQCN resolution
const IMPORT_RE = /^\s*import\s+([\w.]+)\s*;/;

// @Mixin(Foo.class)  or  @Mixin({Foo.class, Bar.class})  or  @Mixin(value = Foo.class)
// Also handles  @Mixin(value = {Foo.class, Bar.class}, priority = 900)
const MIXIN_ANNOTATION_START_RE = /^\s*@Mixin\s*\(/;
const MIXIN_TARGET_RE = /(\w[\w.]*?)\.class/g;
const MIXIN_PRIORITY_RE = /priority\s*=\s*(\d+)/;

// String-form targets: @Mixin(targets = "pkg.Class") or @Mixin(targets = {"pkg.A", "pkg.B"})
const MIXIN_TARGETS_STRING_RE = /targets\s*=\s*(?:\{([^}]+)\}|"([^"]+)")/;
const MIXIN_TARGETS_STRING_ITEM_RE = /"([^"]+)"/g;

// Injection annotations: @Inject, @Redirect, @ModifyArg, @ModifyVariable, @ModifyConstant, @ModifyExpressionValue
// Also MixinExtras: @WrapOperation, @WrapWithCondition, @ModifyReturnValue
const INJECTION_ANNOTATION_RE =
  /^\s*@(Inject|Redirect|ModifyArg|ModifyVariable|ModifyConstant|ModifyExpressionValue|WrapOperation|WrapWithCondition|ModifyReturnValue)\s*\(/;
const METHOD_ATTR_RE = /method\s*=\s*"([^"]+)"/;
const METHOD_ATTR_ARRAY_RE = /method\s*=\s*\{([^}]+)\}/;
const METHOD_ATTR_ITEM_RE = /"([^"]+)"/g;

// @Shadow field / method
const SHADOW_ANNOTATION_RE = /^\s*@Shadow\b/;
const FIELD_DECL_RE =
  /(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?(?:volatile\s+)?([\w.][\w<>,.\s?\[\]]*?)\s+(\w+)\s*[;=]/;
const METHOD_DECL_RE =
  /(?:private|protected|public)?\s*(?:default\s+)?(?:static\s+)?(?:synchronized\s+)?(?:abstract\s+)?(?:native\s+)?(?:<[\w<>,.\s?&\[\]]+>\s+)?([\w.][\w<>,.\s?\[\]]*?)\s+(\w+)\s*\(/;

// @Accessor / @Invoker
const ACCESSOR_ANNOTATION_RE = /^\s*@(Accessor|Invoker)\s*(?:\(\s*\)|\(\s*(?:value\s*=\s*)?"([^"]+)"\s*(?:,\s*\w+\s*=\s*(?:\w+|"[^"]*")\s*)*\))?(?:\s|$)/;
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

/**
 * Skip past annotations (including multi-line ones) starting at `startIndex`.
 * Returns the index of the first non-annotation line.
 * Lines with inline annotation + declaration (e.g. `@Nullable private int x;`)
 * are treated as declaration lines (not skipped).
 */
function skipAnnotations(lines: string[], startIndex: number): number {
  let idx = startIndex;
  while (idx < lines.length && /^\s*@/.test(lines[idx])) {
    if (lines[idx].includes("(")) {
      // Check if parentheses are unbalanced (multi-line annotation) — always skip
      let depth = 0;
      for (const ch of lines[idx]) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
      }
      if (depth > 0) {
        // Multi-line annotation — skip to its end
        const { endIndex } = collectMultilineAnnotation(lines, idx);
        idx = endIndex + 1;
        continue;
      }
      // Single-line annotation with parens: check if declaration text remains
      const stripped = stripInlineAnnotations(lines[idx]);
      if (stripped === "") {
        idx++;
      } else {
        break; // declaration with inline annotation
      }
    } else {
      // Simple annotation like `@Final` — check for trailing declaration
      const stripped = lines[idx].replace(/^\s*@[\w$.]+\s*/, "").trim();
      if (stripped === "") {
        idx++;
      } else {
        break; // e.g. `@Deprecated public abstract void foo();`
      }
    }
  }
  return idx;
}

/** Strip inline annotations (e.g. `@Final @Nullable`) from a declaration line. */
const INLINE_ANNOTATION_RE = /\s*@[\w$.]+(?:\([^)]*\))?\s*/g;
function stripInlineAnnotations(line: string): string {
  return line.replace(INLINE_ANNOTATION_RE, " ").trim();
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
  const imports = new Map<string, string>();
  let className = "";
  let priority: number | undefined;

  // --- Pass 0: extract imports ---
  for (const line of lines) {
    const importMatch = IMPORT_RE.exec(line);
    if (importMatch) {
      const fqcn = importMatch[1];
      // Skip wildcard imports (e.g. import java.util.*)
      if (!fqcn.endsWith("*")) {
        const simpleName = fqcn.substring(fqcn.lastIndexOf(".") + 1);
        imports.set(simpleName, fqcn);
      }
    }
  }

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
      // Fallback: parse targets = "..." or targets = {"a", "b"} string form
      if (targets.length === 0) {
        const targetsStringMatch = MIXIN_TARGETS_STRING_RE.exec(mixinText);
        if (targetsStringMatch) {
          const arrayContent = targetsStringMatch[1]; // {..."..."...} content
          const singleTarget = targetsStringMatch[2]; // single "..." content
          if (arrayContent) {
            MIXIN_TARGETS_STRING_ITEM_RE.lastIndex = 0;
            let itemMatch: RegExpExecArray | null;
            while ((itemMatch = MIXIN_TARGETS_STRING_ITEM_RE.exec(arrayContent)) !== null) {
              targets.push({ className: itemMatch[1] });
            }
          } else if (singleTarget) {
            targets.push({ className: singleTarget });
          }
        }
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
        // Try array form: method = {"m1", "m2"}
        const arrayMatch = METHOD_ATTR_ARRAY_RE.exec(fullAnnotation);
        if (arrayMatch) {
          const inner = arrayMatch[1];
          METHOD_ATTR_ITEM_RE.lastIndex = 0;
          let itemMatch: RegExpExecArray | null;
          let found = false;
          while ((itemMatch = METHOD_ATTR_ITEM_RE.exec(inner)) !== null) {
            injections.push({ annotation, method: itemMatch[1], line: lineNum });
            found = true;
          }
          if (!found) {
            parseWarnings.push(`Line ${lineNum}: @${annotation} method array is empty.`);
          }
        } else {
          parseWarnings.push(`Line ${lineNum}: @${annotation} missing method attribute.`);
        }
      }
      i = endIndex + 1;
      continue;
    }

    // --- @Shadow ---
    if (SHADOW_ANNOTATION_RE.test(line)) {
      // Advance past @Shadow line to find the declaration
      let declLine = i + 1;
      // Skip additional annotations between @Shadow and declaration (including multi-line)
      declLine = skipAnnotations(lines, declLine);
      if (declLine < lines.length) {
        const declText = stripInlineAnnotations(lines[declLine]);
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

      // Find the method declaration following the annotation (skip multi-line annotations)
      let methodLine = i + 1;
      methodLine = skipAnnotations(lines, methodLine);
      if (methodLine < lines.length) {
        const methodDeclMatch = METHOD_DECL_RE.exec(stripInlineAnnotations(lines[methodLine]));
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
    imports,
    injections,
    shadows,
    accessors,
    parseWarnings
  };
}
