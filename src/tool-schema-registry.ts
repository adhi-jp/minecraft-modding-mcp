import { z } from "zod";

const registry = new Map<string, z.ZodTypeAny>();

export function registerToolSchema(name: string, schema: z.ZodTypeAny): void {
  if (registry.has(name)) {
    throw new Error(`Tool schema already registered: ${name}`);
  }
  registry.set(name, schema);
}

export function getToolSchema(name: string): z.ZodTypeAny | undefined {
  return registry.get(name);
}

export type ValidateToolParamsResult =
  | { valid: true; data: unknown }
  | { valid: false; errors: Array<{ path: string; message: string }> };

export function validateToolParams(
  name: string,
  params: unknown
): ValidateToolParamsResult {
  const schema = registry.get(name);
  if (!schema) {
    return {
      valid: false,
      errors: [{ path: "", message: `Unknown tool: ${name}` }]
    };
  }
  const result = schema.safeParse(params);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

export function listRegisteredTools(): string[] {
  return [...registry.keys()].sort();
}

/** O(1) registry size — the populated-registry probe for per-request paths. */
export function registeredToolCount(): number {
  return registry.size;
}

export function clearRegisteredToolsForTest(): void {
  registry.clear();
}
