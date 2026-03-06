# Namespace Redesign: `official` -> `obfuscated`

## Summary

The MCP public mapping namespace `official` is misleading in current Minecraft modding workflows because users reasonably read it as "Mojang official mappings" rather than "obfuscated runtime names". This redesign removes `official` from the public contract and replaces it with `obfuscated`.

The new public namespace set is:

- `obfuscated`
- `mojang`
- `intermediary`
- `yarn`

This is a breaking change. No compatibility alias for `official` will be provided.

## Goals

- Align the public API with current modding terminology and user expectations.
- Make the "runtime obfuscated names" namespace explicit.
- Remove the `official` label from docs, diagnostics, and response payloads.
- Keep `mojang` unchanged to minimize additional migration cost.

## Non-Goals

- Renaming `mojang` to `mojmap`.
- Adding compatibility aliases for removed names.
- Preserving old cache/database contents that store `official`.

## Public Contract Changes

- Replace `official` with `obfuscated` in all public input enums:
  - `mapping`
  - `sourceMapping`
  - `targetMapping`
  - `classNameMapping`
- Replace `official` with `obfuscated` in all public outputs:
  - `requestedMapping`
  - `mappingApplied`
  - `mappingContext`
  - `classIdentity`
  - `get-class-api-matrix` row keys
- Reject `official` as invalid input with `ERR_INVALID_INPUT` and a suggested replacement of `obfuscated`.

## Internal Design

- Rename the internal canonical namespace from `official` to `obfuscated`.
- Update all mapping graph edges, pair keys, and transform chain labels accordingly.
- Update all diagnostics to describe the namespace as "obfuscated" or "runtime obfuscated names".
- For unobfuscated versions, warnings must explain that the runtime is already deobfuscated rather than implying that "official" names remain final.

## Storage and Cache

- Existing artifact rows may contain `requested_mapping='official'` or `mapping_applied='official'`.
- The SQLite schema version will be bumped so existing caches are rebuilt instead of partially reused.
- No migration layer for old cached namespace strings will be added.

## Testing Strategy

Add failing tests first for:

- Public schemas accepting `obfuscated` and rejecting `official`.
- Mapping graph operations using `obfuscated`.
- Source service diagnostics and suggested calls using `obfuscated`.
- API matrix response keys using `obfuscated`.
- Storage/cache behavior remaining safe after schema version bump.

## Documentation

Update `README.md` and `CHANGELOG.md` in the same change set. Document the breaking rename clearly under `Unreleased`.
