import { z } from "zod";

/**
 * Advertised input schema of a catalog tool, generated from its validating
 * zod schema: input side (defaults shown, preprocessing hidden), every shared
 * sub-schema inlined so the result carries no `$ref`/`$defs`, and without the
 * artifacts zod adds that carry no contract — the `$schema` dialect URI and
 * the safe-integer bounds (`minimum: -9007199254740991`,
 * `maximum: 9007199254740991`) that `int()` emits.
 */
export function toAdvertisedInputSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { io: "input", reused: "inline" }) as Record<string, unknown>;
  delete generated.$schema;
  return stripSafeIntegerBounds(generated) as Record<string, unknown>;
}

function stripSafeIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripSafeIntegerBounds);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (
      (key === "maximum" && value === Number.MAX_SAFE_INTEGER) ||
      (key === "minimum" && value === Number.MIN_SAFE_INTEGER)
    ) {
      continue;
    }
    output[key] = stripSafeIntegerBounds(value);
  }
  return output;
}
