export { checkSymbolExistsInUnobfuscatedRuntime } from "./lifecycle/runtime-check.js";
export { traceSymbolLifecycle } from "./lifecycle/trace.js";
export { diffClassSignatures } from "./lifecycle/diff.js";
export {
  rejectLifecycleClassLikeInput,
  releaseLifecycleMappingGraph,
  resolveToObfuscatedClassName,
  resolveToObfuscatedMemberName,
  remapSignatureMembers
} from "./lifecycle/mapping-helpers.js";
