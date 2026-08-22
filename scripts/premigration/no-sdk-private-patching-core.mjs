/**
 * AST-based "no SDK-private patching" scanner (core).
 *
 * Parsing is SYNTAX-ONLY (`ts.createSourceFile`): no `ts.Program`, no type
 * checker, no `node_modules` resolution. That keeps a full src/ scan fast
 * enough to run as an ordinary unit test rather than a script nobody executes.
 *
 * Three rules, each carrying a stable id so findings stay greppable:
 *
 *  A:type-cast-member-assignment
 *    A WRITE — assignment, compound assignment, `++`/`--`, bracket write, or
 *    `Object.assign(target, ...)` — whose target chain ROOTS at an `as any` or
 *    `as unknown as { ... }` cast. This is the monkey-patching mechanism
 *    itself, independent of which member is written.
 *
 *  B:sdk-private-member-write
 *    In a file that imports any `@modelcontextprotocol/*` package, a write to
 *    a statically-known private member: an underscore-prefixed name or the
 *    `validateToolInput` hook. Covers dot access, string-literal and
 *    no-substitution-template bracket access, and object-literal properties
 *    (shorthand, computed, or method) handed to `Object.assign`.
 *
 *  C:sdk-internal-deep-import
 *    An import / export / dynamic-import / require specifier that reaches into
 *    `node_modules/` or `@modelcontextprotocol/<pkg>/dist/`. Public subpath
 *    exports (`@modelcontextprotocol/server`, `.../server/stdio`) are fine.
 *
 * Reads and calls are never findings: `server["_priv"].get(x)` and
 * `(server as any).hook(args)` observe, they do not patch.
 *
 * @typedef {object} Finding
 * @property {string} rule      Stable rule id (see above).
 * @property {string} file      Repo-relative path, forward slashes.
 * @property {number} line      1-based.
 * @property {number} column    1-based.
 * @property {string} [member]  Written member, when statically known.
 * @property {string} [specifier] Module specifier, for rule C.
 * @property {string} excerpt   Bounded single-line source excerpt.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const RULE_CAST_WRITE = "A:type-cast-member-assignment";
const RULE_PRIVATE_WRITE = "B:sdk-private-member-write";
const RULE_DEEP_IMPORT = "C:sdk-internal-deep-import";

const SDK_SCOPE_PREFIX = "@modelcontextprotocol/";
/** Underscore-prefixed members are private by convention across the SDK. */
const PRIVATE_MEMBER_RE = /^_[A-Za-z_$][\w$]*$/;
/** Named private hooks that carry no underscore. */
const PRIVATE_HOOKS = new Set(["validateToolInput"]);
/** `@modelcontextprotocol/<pkg>/dist/...` reaches past the package's exports. */
const SDK_DIST_RE = /@modelcontextprotocol\/[^/]+\/dist\//;

const EXCERPT_LIMIT = 160;

const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

const CAST_KINDS = new Set([ts.SyntaxKind.AsExpression, ts.SyntaxKind.TypeAssertionExpression]);

/** Strips parentheses and non-null assertions, which never change the target. */
function unwrap(node) {
  let current = node;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isCast(node) {
  return node !== undefined && CAST_KINDS.has(node.kind);
}

/**
 * True for the two shapes that deliberately erase a type to reach a private
 * member: `x as any` and `x as unknown as { ... }`. A cast to a NAMED type is
 * intentionally NOT suspicious — that is ordinary typed code, and flagging it
 * would drown the check in false positives.
 */
function isSuspiciousCast(node) {
  const expr = unwrap(node);
  if (!isCast(expr)) {
    return false;
  }
  if (expr.type.kind === ts.SyntaxKind.AnyKeyword) {
    return true;
  }
  if (ts.isTypeLiteralNode(expr.type)) {
    const inner = unwrap(expr.expression);
    if (isCast(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
      return true;
    }
  }
  // `((x as any) as Foo).bar = 1` still roots at the `as any`.
  return isSuspiciousCast(expr.expression);
}

/** Walks a member-access chain down to whatever it is rooted on. */
function accessRoot(node) {
  let current = unwrap(node);
  while (
    current !== undefined &&
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
  ) {
    current = unwrap(current.expression);
  }
  return current;
}

/** The literal text of a statically-known string, or undefined. */
function staticStringOf(expression) {
  const expr = unwrap(expression);
  if (expr === undefined) {
    return undefined;
  }
  // isStringLiteralLike covers both "x" and `x` (no substitutions).
  return ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

/** The written member name of a property/element access, when static. */
function staticMemberName(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) ? node.name.text : undefined;
  }
  if (ts.isElementAccessExpression(node)) {
    return staticStringOf(node.argumentExpression);
  }
  return undefined;
}

/** The node whose position best identifies the written member. */
function memberAnchor(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name;
  }
  if (ts.isElementAccessExpression(node)) {
    return node.argumentExpression ?? node;
  }
  return node;
}

function isPrivateMemberName(name) {
  return typeof name === "string" && (PRIVATE_MEMBER_RE.test(name) || PRIVATE_HOOKS.has(name));
}

function propertyNameOf(nameNode) {
  if (nameNode === undefined) {
    return undefined;
  }
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return nameNode.text;
  }
  if (ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text;
  }
  if (ts.isComputedPropertyName(nameNode)) {
    return staticStringOf(nameNode.expression);
  }
  return undefined;
}

function isObjectAssignCall(node) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  const callee = unwrap(node.expression);
  if (callee === undefined || !ts.isPropertyAccessExpression(callee)) {
    return false;
  }
  if (callee.name.text !== "assign") {
    return false;
  }
  const receiver = unwrap(callee.expression);
  return receiver !== undefined && ts.isIdentifier(receiver) && receiver.text === "Object";
}

/**
 * The members an `Object.assign(target, ...sources)` writes, as far as they are
 * statically knowable. Spreads and computed non-literal keys contribute an
 * entry with no name so rule A can still report the write site.
 */
function objectAssignWrites(call) {
  const writes = [];
  for (const source of call.arguments.slice(1)) {
    const literal = unwrap(source);
    if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
      writes.push({ name: undefined, anchor: source });
      continue;
    }
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        writes.push({ name: undefined, anchor: property });
        continue;
      }
      writes.push({ name: propertyNameOf(property.name), anchor: property.name ?? property });
    }
  }
  return writes;
}

/** Every module specifier the file references, in any syntactic form. */
function collectModuleSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const text = staticStringOf(node.moduleSpecifier);
      if (text !== undefined) specifiers.push({ text, node: node.moduleSpecifier });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const text = staticStringOf(node.moduleReference.expression);
      if (text !== undefined) specifiers.push({ text, node: node.moduleReference.expression });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const text = staticStringOf(node.argument.literal);
      if (text !== undefined) specifiers.push({ text, node: node.argument.literal });
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = callee !== undefined && ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        const text = staticStringOf(node.arguments[0]);
        if (text !== undefined) specifiers.push({ text, node: node.arguments[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function positionOf(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function excerptAt(sourceText, node, sourceFile) {
  return sourceText
    .slice(node.getStart(sourceFile), node.getStart(sourceFile) + EXCERPT_LIMIT)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" \\n ")
    .slice(0, EXCERPT_LIMIT);
}

/** Stable ordering: file, line, column, rule, then member/specifier. */
export function sortFindings(findings) {
  return [...findings].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule) ||
      (left.member ?? left.specifier ?? "").localeCompare(right.member ?? right.specifier ?? "")
  );
}

function scriptKindFor(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Scans one source text. `filePath` is recorded verbatim on every finding, so
 * callers pass the repo-relative path they want reported.
 *
 * @param {{ filePath: string, sourceText: string }} input
 * @returns {Finding[]}
 */
export function scanSourceText({ filePath, sourceText }) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(filePath)
  );

  const findings = [];
  const specifiers = collectModuleSpecifiers(sourceFile);
  const importsSdk = specifiers.some((entry) => entry.text.startsWith(SDK_SCOPE_PREFIX));

  const add = (rule, node, extra) => {
    findings.push({
      rule,
      file: filePath,
      ...positionOf(sourceFile, node),
      ...extra,
      excerpt: excerptAt(sourceText, node, sourceFile)
    });
  };

  /** A direct write (`=`, compound, `++`/`--`) to a member-access target. */
  const recordDirectWrite = (writeNode, targetExpression) => {
    const target = unwrap(targetExpression);
    if (target === undefined) {
      return;
    }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
      return;
    }
    const member = staticMemberName(target);

    if (isSuspiciousCast(accessRoot(target))) {
      add(RULE_CAST_WRITE, writeNode, member === undefined ? {} : { member });
    }
    if (importsSdk && isPrivateMemberName(member)) {
      add(RULE_PRIVATE_WRITE, memberAnchor(target), { member });
    }
  };

  const recordObjectAssign = (call) => {
    const [targetArgument] = call.arguments;
    if (targetArgument === undefined) {
      return;
    }
    const writes = objectAssignWrites(call);
    const patchesThroughCast = isSuspiciousCast(accessRoot(targetArgument));

    if (patchesThroughCast) {
      const named = writes.filter((write) => write.name !== undefined);
      if (named.length === 0) {
        add(RULE_CAST_WRITE, call, {});
      } else {
        for (const write of named) {
          add(RULE_CAST_WRITE, call, { member: write.name });
        }
      }
    }

    if (importsSdk) {
      for (const write of writes) {
        if (isPrivateMemberName(write.name)) {
          add(RULE_PRIVATE_WRITE, write.anchor, { member: write.name });
        }
      }
    }
  };

  const visit = (node) => {
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      recordDirectWrite(node, node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordDirectWrite(node, node.operand);
    } else if (isObjectAssignCall(node)) {
      recordObjectAssign(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const { text, node } of specifiers) {
    if (text.includes("node_modules/") || SDK_DIST_RE.test(text)) {
      add(RULE_DEEP_IMPORT, node, { specifier: text });
    }
  }

  return sortFindings(findings);
}

function collectSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (/\.(ts|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Scans every non-declaration TypeScript file under `sourceRoot`.
 *
 * Returns the scanned file inventory alongside the findings so callers can
 * assert the scan was not vacuous — a misrooted scan finds nothing, which
 * looks identical to a clean tree.
 *
 * @param {{ repoRoot: string, sourceRoot: string }} input
 * @returns {{ files: string[], findings: Finding[] }}
 */
export function scanSourceTree({ repoRoot, sourceRoot }) {
  const absoluteFiles = collectSourceFiles(sourceRoot).sort();
  const files = [];
  const findings = [];
  for (const absolute of absoluteFiles) {
    const filePath = relative(repoRoot, absolute).split("\\").join("/");
    files.push(filePath);
    findings.push(...scanSourceText({ filePath, sourceText: readFileSync(absolute, "utf8") }));
  }
  return { files, findings: sortFindings(findings) };
}

/**
 * Renders findings for a terminal, capped at `limit` entries.
 *
 * @param {Finding[]} findings
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function formatFindings(findings, { limit = 50 } = {}) {
  const shown = findings.slice(0, limit);
  const lines = shown.map(
    (finding) =>
      `  [${finding.rule}] ${finding.file}:${finding.line}:${finding.column} ${finding.member ?? finding.specifier ?? ""}\n      ${finding.excerpt}`
  );
  if (findings.length > shown.length) {
    lines.push(`  ... ${findings.length - shown.length} more finding(s) not shown`);
  }
  return lines.join("\n");
}
