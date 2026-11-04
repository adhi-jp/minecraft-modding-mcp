/**
 * The `meta.deprecated` block of alias replies (helper module, not a test
 * file): the expected block from the inventory's alias data, and the
 * normalizer rule that removes the block from a normalized tools/call reply
 * so the reply can be compared with an 8.x golden.
 */
import assert from "node:assert/strict";

import { ALIAS_TOOL_INVENTORY, CATALOG_TOOL_NAMES } from "../../src/tools/inventory.ts";

/** The removal release every alias names. */
export const ALIAS_REMOVE_IN = "10.0.0";

export type DeprecationBlock = { replacedBy: string[]; removeIn: string };

/**
 * The block an alias call is expected to carry: the alias's replacements,
 * or only the task's tool when the own `args.task` property is one of the
 * alias's tasks.
 */
export function expectedDeprecation(tool: string, args?: unknown): DeprecationBlock {
  const entry = ALIAS_TOOL_INVENTORY.find((candidate) => candidate.name === tool);
  assert.ok(entry, `${tool} is an alias in the tool inventory`);
  const task =
    typeof args === "object" && args !== null && Object.hasOwn(args, "task")
      ? (args as { task?: unknown }).task
      : undefined;
  const taskTool =
    entry.tasks !== undefined && typeof task === "string" && Object.hasOwn(entry.tasks, task)
      ? entry.tasks[task]
      : undefined;
  return { replacedBy: taskTool !== undefined ? [taskTool] : [...entry.replacedBy], removeIn: ALIAS_REMOVE_IN };
}

/** What `stripDeprecation` removed: the block of `structuredContent.meta` and of the JSON text's `meta`. */
export type RemovedDeprecation = { structured: unknown; text: unknown[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Removes `meta.deprecated` from an envelope (in place on a copy) and returns the removed value. */
function removeFromEnvelope(envelope: Record<string, unknown> | undefined): unknown {
  const meta = asRecord(envelope?.meta);
  if (meta === undefined || !("deprecated" in meta)) return undefined;
  const { deprecated, ...rest } = meta;
  envelope!.meta = rest;
  return deprecated;
}

/**
 * Normalizer rule for alias replies: removes `meta.deprecated` from a
 * NORMALIZED tools/call reply message — `result.structuredContent.meta` and
 * the `meta` of every `result.content[].text.__normalizedJson` — and returns
 * the message without it plus the removed values. Other messages pass
 * through unchanged.
 */
export function stripDeprecation(message: unknown): { message: unknown; removed: RemovedDeprecation } {
  const copy = structuredClone(message);
  const removed: RemovedDeprecation = { structured: undefined, text: [] };
  const result = asRecord(asRecord(copy)?.result);
  if (result === undefined) return { message: copy, removed };
  removed.structured = removeFromEnvelope(asRecord(result.structuredContent));
  if (Array.isArray(result.content)) {
    for (const entry of result.content) {
      const normalizedJson = asRecord(asRecord(asRecord(entry)?.text)?.__normalizedJson);
      const fromText = removeFromEnvelope(normalizedJson);
      if (fromText !== undefined) removed.text.push(fromText);
    }
  }
  return { message: copy, removed };
}

/**
 * Asserts that a reply to `tool` carried the expected deprecation block in
 * both representations, naming catalog tools and the removal release.
 */
export function assertDeprecationCarried(
  removed: RemovedDeprecation,
  tool: string,
  args: unknown,
  label: string
): void {
  const live = removed.structured as DeprecationBlock | undefined;
  assert.deepEqual(live, expectedDeprecation(tool, args), `${label}: structuredContent.meta.deprecated`);
  assert.deepEqual(removed.text, [live], `${label}: the JSON text carries the same meta.deprecated`);
  assert.ok(live!.replacedBy.length > 0, `${label}: names at least one replacement`);
  for (const name of live!.replacedBy) {
    assert.ok(CATALOG_TOOL_NAMES.has(name), `${label}: replacement ${name} is a catalog tool`);
  }
  assert.equal(live!.removeIn, "10.0.0", `${label}: removal release`);
}
