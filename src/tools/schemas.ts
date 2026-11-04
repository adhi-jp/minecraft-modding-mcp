import { z } from "zod";

/**
 * Shared input building blocks for catalog tools. Every control object is a
 * strict object, so an unknown or misplaced key fails validation instead of
 * being dropped. Rules a flat JSON Schema cannot express (which locator a
 * target kind needs, which fields a symbol kind takes) live in refinements and
 * in the descriptions.
 */

/** A non-empty string after trimming; the value handed on is the trimmed one. */
export const nonEmptyString = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;
const numericInputSchemas = new WeakSet<object>();

function numberFromNumericString(value: unknown): unknown {
  if (typeof value === "string" && NUMERIC_STRING.test(value.trim())) {
    return Number(value.trim());
  }
  return value;
}

/**
 * Accepts a number or a numeric string (`"20"`) for `schema`. Strings are the
 * only coercion: booleans, empty strings and other values still fail. The
 * advertised JSON Schema is the number schema itself.
 */
export function numericInput<T extends z.ZodNumber>(schema: T) {
  const wrapped = z.preprocess(numberFromNumericString, schema);
  numericInputSchemas.add(wrapped);
  return wrapped;
}

export function isNumericInputSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && numericInputSchemas.has(schema);
}

// ---------------------------------------------------------------------------
// Namespaces and detail
// ---------------------------------------------------------------------------

export const MAPPING_NAMESPACES = ["obfuscated", "mojang", "intermediary", "yarn"] as const;
export type MappingNamespace = (typeof MAPPING_NAMESPACES)[number];

/** Namespace of the names in the request and the reply (`mapping`) or the destination (`toMapping`). */
export const mappingSchema = z.enum(MAPPING_NAMESPACES);

export const DETAIL_LEVELS = ["summary", "standard", "full"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** `detail` with its default advertised in the input schema. */
export function detailSchema(defaultLevel: DetailLevel) {
  return z.enum(DETAIL_LEVELS).default(defaultLevel);
}

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

export const TARGET_KINDS = ["artifact", "version", "jar", "coordinate", "workspace", "dependency"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const ARTIFACT_SCOPES = ["vanilla", "merged", "loader"] as const;

export type TargetField =
  | "artifactId"
  | "version"
  | "jarPath"
  | "coordinate"
  | "projectPath"
  | "group"
  | "name"
  | "dependencyVersion"
  | "scope";

/** Locator fields each target kind requires and additionally accepts. */
export const TARGET_FIELDS_BY_KIND: Readonly<
  Record<TargetKind, { readonly required: readonly TargetField[]; readonly optional: readonly TargetField[] }>
> = {
  artifact: { required: ["artifactId"], optional: [] },
  version: { required: ["version"], optional: ["projectPath", "scope"] },
  jar: { required: ["jarPath"], optional: [] },
  coordinate: { required: ["coordinate"], optional: [] },
  workspace: { required: ["projectPath"], optional: ["scope"] },
  dependency: { required: ["group", "name"], optional: ["dependencyVersion", "projectPath"] }
};

const TARGET_FIELD_SCHEMAS: Readonly<Record<TargetField, z.ZodType>> = {
  artifactId: nonEmptyString,
  version: nonEmptyString,
  jarPath: nonEmptyString,
  coordinate: nonEmptyString,
  projectPath: nonEmptyString,
  group: nonEmptyString,
  name: nonEmptyString,
  dependencyVersion: nonEmptyString,
  scope: z.enum(ARTIFACT_SCOPES)
};

type TargetFieldsOf = (kind: TargetKind) => {
  readonly required: readonly TargetField[];
  readonly optional: readonly TargetField[];
};

/** Each shared `target` schema with the kinds it takes and the fields of each kind. */
const sharedTargetSchemas = new WeakMap<object, { kinds: readonly TargetKind[]; fieldsOf: TargetFieldsOf }>();

function describeTargetKinds(
  kinds: readonly TargetKind[],
  fieldsOf: TargetFieldsOf
): string {
  const parts = kinds.map((kind) => {
    const { required, optional } = fieldsOf(kind);
    if (kind === "dependency") {
      // One of dependencyVersion and projectPath is required.
      const rest = optional.filter((field) => field !== "dependencyVersion" && field !== "projectPath");
      return `dependency: ${[...required, "dependencyVersion|projectPath", ...rest.map((field) => `${field}?`)].join(",")}`;
    }
    return `${kind}: ${[...required, ...optional.map((field) => `${field}?`)].join(",")}`;
  });
  return `Fields per kind (?=optional): ${parts.join("; ")}. Other fields rejected.`;
}

/**
 * The shared `target` object for a tool that supports `kinds`. Only the
 * locator fields of those kinds are declared; within one request, a field
 * the chosen kind does not take is rejected and a required one must be set.
 * `optionalFields` narrows the optional fields of a kind for a tool whose
 * service has no use for them, so they are rejected instead of ignored.
 */
export function targetSchema(
  kinds: readonly [TargetKind, ...TargetKind[]],
  optionalFields: Partial<Record<TargetKind, readonly TargetField[]>> = {}
) {
  const fieldsOf: TargetFieldsOf = (kind) => {
    const { required, optional } = TARGET_FIELDS_BY_KIND[kind];
    const narrowed = optionalFields[kind];
    return { required, optional: narrowed === undefined ? optional : optional.filter((field) => narrowed.includes(field)) };
  };
  const fields = new Set<TargetField>();
  for (const kind of kinds) {
    for (const field of fieldsOf(kind).required) fields.add(field);
    for (const field of fieldsOf(kind).optional) fields.add(field);
  }
  const shape: Record<string, z.ZodType> = { kind: z.enum(kinds) };
  for (const field of fields) {
    shape[field] = TARGET_FIELD_SCHEMAS[field].optional();
  }
  const schema = z
    .strictObject(shape)
    .superRefine((value, ctx) => {
      const kind = value.kind as TargetKind;
      const { required, optional } = fieldsOf(kind);
      const accepted = new Set<string>(["kind", ...required, ...optional]);
      for (const key of Object.keys(value)) {
        if (!accepted.has(key) && value[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `"${key}" is not accepted with target kind "${kind}"; it takes ${[...required, ...optional].join(", ")}.`
          });
        }
      }
      for (const field of required) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `Target kind "${kind}" requires "${field}".`
          });
        }
      }
      if (kind === "dependency" && value.dependencyVersion === undefined && value.projectPath === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["dependencyVersion"],
          message:
            'Target kind "dependency" requires "dependencyVersion", or "projectPath" to read the version from the project.'
        });
      }
    })
    .describe(describeTargetKinds(kinds, fieldsOf));
  sharedTargetSchemas.set(schema, { kinds, fieldsOf });
  return schema;
}

export function isSharedTargetSchema(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null && sharedTargetSchemas.has(schema);
}

/**
 * The fields a shared `target` schema takes with `kind`: `keys`, `kind` plus
 * every field of that kind, and `locators`, the fields that say where to look
 * (the kind's required fields). Undefined when `schema` is not a shared
 * `target` schema or `kind` is not one of the kinds it takes.
 */
export function targetFieldsForKind(
  schema: unknown,
  kind: unknown
): { keys: string[]; locators: readonly TargetField[] } | undefined {
  const target = typeof schema === "object" && schema !== null ? sharedTargetSchemas.get(schema) : undefined;
  const known = target?.kinds.find((entry) => entry === kind);
  if (target === undefined || known === undefined) return undefined;
  const { required, optional } = target.fieldsOf(known);
  return { keys: ["kind", ...required, ...optional], locators: required };
}

// ---------------------------------------------------------------------------
// Symbol
// ---------------------------------------------------------------------------

export const SYMBOL_KINDS = ["class", "field", "method"] as const;

/**
 * Characters a member's simple name cannot hold: they belong to the owner
 * (`.`, `/`) or the descriptor (`(`, `)`, `;`). `<init>`, `<clinit>` and `$`
 * are part of real member names.
 */
export const NOT_IN_SIMPLE_MEMBER_NAME = /[./();]/;

/** Why a `memberName` that holds an owner or descriptor character is rejected. */
export const SIMPLE_MEMBER_NAME_MESSAGE =
  '"memberName" is the member\'s simple name; the owner goes in "className" and the descriptor in "descriptor".';

/** One class, field or method: a fully qualified class name plus the member for fields and methods. */
export const symbolSchema = z
  .strictObject({
    kind: z.enum(SYMBOL_KINDS),
    className: nonEmptyString,
    memberName: nonEmptyString.optional(),
    descriptor: nonEmptyString.optional()
  })
  .superRefine((value, ctx) => {
    if (value.kind === "class") {
      for (const key of ["memberName", "descriptor"] as const) {
        if (value[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `"${key}" is not accepted with symbol kind "class".`
          });
        }
      }
      return;
    }
    if (value.kind === "field" && value.descriptor !== undefined) {
      // Every symbol lookup refuses a field descriptor; it names a method's signature only.
      ctx.addIssue({
        code: "custom",
        path: ["descriptor"],
        message: '"descriptor" is not accepted with symbol kind "field"; only a method takes one.'
      });
    }
    if (value.memberName === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["memberName"],
        message: `Symbol kind "${value.kind}" requires "memberName".`
      });
    } else if (NOT_IN_SIMPLE_MEMBER_NAME.test(value.memberName)) {
      ctx.addIssue({
        code: "custom",
        path: ["memberName"],
        message: SIMPLE_MEMBER_NAME_MESSAGE
      });
    }
  })
  .describe("kind class: className; field: className+memberName; method: className+memberName (optional descriptor).");
