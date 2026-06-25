# State-Space Matrix

Convert examples into dimensions. The named example is a clue about where the
bug was noticed, not the full boundary of the fix.

## Generality Guard

Name the abstract dimension before the concrete domain example. UI, web, asset,
animation, tooling, backend, data, CLI, library, and runtime examples are
pressure cases, not universal requirements. Specialize only after naming the
underlying contract: representation, runtime artifact, lifecycle, ordering,
identity, environment, permission, cleanup, or another relevant dimension.

When proof uses domain-specific tools, keep the abstract contract beside the
tool: browser cache -> runtime-artifact freshness; animation trace -> ordering
or cleanup. A tool can be required for this report without becoming a
requirement for other domains.

## Common Dimensions

Use only dimensions relevant to the report:

- Input representation: raw value, parsed value, normalized value, display
  label, alias, ID, slug, filename, cache key, serialized form.
- Encoding and syntax: spaces, commas, quotes, slashes, Unicode, escaping,
  case-folding, path separators, query encoding, JSON/XML/CSV forms.
- Environment and origin: local, staging, production, tenant, host, protocol,
  browser, platform, loader, region, clock, feature flag.
- Permission and trust boundary: user role, session state, token scope, signed
  data, cross-origin boundary, caller identity, confirmed destination.
- Direction or route: forward/back, source/target, import/export, read/write,
  request/response, client/server, primary/fallback.
- Lifecycle state: first load, refresh, save, cancel, retry, delete, undo,
  restart, migration, cleanup, rollback.
- Cache and artifact: stale cache, generated asset, built bundle, package,
  binary, database migration, lockfile, running process.
- Error and cancel path: validation failure, exception, timeout, retry, partial
  write, cancellation, teardown, recovery.

## Dynamic and Concurrent Dimensions

For visual, async, streaming, event-driven, queue, cache, or lifecycle bugs,
include:

- Temporal sequence: before, during, after, delayed, retried, interrupted.
- Ordering: first/last, adjacent updates, sorted vs arrival order, reverse
  application, same-parent mutations.
- Overlap: multiple simultaneous items, concurrent users, in-flight requests,
  duplicate events, racing timers.
- Identity: per-entity state, stable IDs, alias/canonical identity, stale
  references, reused objects.
- Reset/cancel: rollback, aborted work, navigation away, retry after failure.
- Final cleanup: stale rendering, leftover locks, retained subscriptions,
  cached errors, leaked temp files.

## Matrix Output

For non-trivial fixes, record a compact matrix with the abstract dimension first:

| Abstract dimension | Domain cases in scope | Preserve/change | Proof |
| --- | --- | --- | --- |
| Representation | Raw ID, encoded display label | Preserve both | Parser and serializer tests |
| Lifecycle | First save, retry, cancel | Change retry only | Regression plus negative cancel case |

Do not create exhaustive matrices for tiny fixes. The point is to prevent
single-example repair when adjacent cases are likely to share the same contract.
