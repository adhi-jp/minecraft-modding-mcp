# Source Routing and Tool Confidence

Use the narrowest authoritative source that can answer the current debug/fix
question. Do not replace missing evidence with memory when behavior depends on
external contracts, permissions, data shape, runtime packaging, or tool
semantics.

## Source Routing

| Question | Preferred source |
| --- | --- |
| What should the product do? | User requirement, product spec, acceptance criteria, existing tests, or known-good behavior. |
| How does current local behavior work? | Local code, tests, fixtures, schema, config, logs, built artifacts, or reproduction. |
| How does an external API/framework/protocol behave? | Official docs, upstream source, authoritative spec, vendor changelog, or user-provided source material. |
| How does a CLI/tool behave? | `--help`, man page, official docs, local wrapper source, logs, or a minimal dry run. |
| Which artifact did the user test? | Build output metadata, process start time, deployed version, bundle hash, package contents, migration state, cache state, or runtime logs. |

When a primary source is unavailable, state why and use the best fallback as a
bounded proof. Keep dependent claims unproven until a better source appears.

## Tool-Confidence Ledger

When a tool fails, classify the failure before changing strategy:

- Failed command: wrong command, flags, path, env, or working directory.
- Failed mode: one subcommand, transport, worker mode, or protocol path failed.
- Failed input shape: the tool rejected this file, prompt, query, encoding, or
  argument set.
- Unavailable service: network, daemon, server, license, credential, or MCP
  service is unavailable.
- Missing permission: sandbox, filesystem, auth, or account scope blocks the
  operation.
- Flaky environment: timeout, restart, race, or transient process failure.
- Stale artifact: the tool observed an old build, cache, generated file, or
  runtime process.

A narrow failure permits a narrow retry or fallback. It does not justify
abandoning all related tools, all workers, all official docs, or all automation.

## Disconfirming Checks

For the preferred cause or fix, name one fast check that could prove it wrong:

- A negative-control test that should fail before the fix and pass after it.
- A source trace showing the suspected code path is not used.
- A runtime artifact check showing the tested artifact lacks the source change.
- A matrix case that exercises the neighboring representation, permission,
  environment, lifecycle, or error path.
