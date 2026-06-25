# Choosing and Excluding Files

The hardest part of "commit please" is not running git — it is deciding which of
the dirty paths belong in *this* commit. Get this wrong and you either bury an
unrelated change in history or leak a secret. Choose by the user-visible change,
not by directory or file type.

## See the whole picture first

A commit decision made from a partial view is a guess. Surface every category in
one pass:

```sh
git status --short --branch --untracked-files=all   # modified, staged, untracked
git status --ignored                                # ignored paths too
git diff --stat                                      # size/shape of tracked edits
git ls-files --others --exclude-standard             # untracked, ignoring ignored
```

`--untracked-files=all` matters: a default `git status` collapses untracked
directories to one line, hiding files inside. `--ignored` matters because an
ignored directory is invisible otherwise and easy to confuse with "untracked but
should be added."

For anything new or surprising, read it before judging — `git diff -- <file>`
for tracked edits, and open untracked files directly. You cannot classify a path
you have not looked at.

## Select one logical change

A good commit is one logical, user-visible change that a reviewer can read,
bisect, and revert as a unit. Group the parts that move together:

- implementation **and** its tests,
- the docs, CHANGELOG, README, or spec the change fulfills,
- the config or fixture the change requires.
- dependency manifests and their lockfiles when the dependency is required by
  the selected implementation.

Split anything whose only connection is "it was dirty at the same time": an
unrelated cleanup, a drive-by typo fix in another module, a refactor riding
along with a feature. Same-session or same-plan provenance is not a reason to
bundle. When two concerns are genuinely independent, make two commits.

Stage by explicit full path so the set is exactly what you chose:

```sh
git add -- src/feature.ts src/feature.test.ts CHANGELOG.md
```

Avoid `git add .`, `git add -A`, and globs while the tree is dirty — they sweep
in whatever else changed (generated output, lock files, an editor's scratch
file, a secret) without you seeing it. If you want to derive the list from git
rather than hand-type it (and risk a stale list), generate it:

```sh
git add -- $(git diff --name-only HEAD)   # all tracked edits, still reviewed after
```

Then always confirm with `git diff --cached --name-only` before committing.

## Exclude deliberately

Some dirty paths almost never belong in a feature/fix commit. Recognize and
leave them unstaged:

- **Generated / build output:** `dist/`, `build/`, compiled bundles, coverage
  reports, `__pycache__/`.
- **Eval / run workspaces:** a generated `evals/<name>/workspace/…` is an
  artifact; the durable `evals/<name>/evals.json` spec is not. Stage the spec,
  not the workspace.
- **Lock files:** include a lockfile when the dependency change is part of this
  commit. If `package.json` or another dependency manifest is in-scope because
  the selected implementation needs a new or changed dependency, the matching
  lockfile belongs with that same commit. Leave a lockfile out only when it is
  unrelated to the selected change.
- **Plans and specs in progress:** `plans/`, `specs/`, scratch notes — commit
  only when the user wants them tracked.
- **Agent / tool state:** `.agents/`, `.claude/`, `.codex/`, local snapshot
  copies, editor caches.
- **Secrets:** `.env`, key files, anything with credentials. These should be
  ignored already; if one shows up untracked, do not commit it — flag it.

Respect `.gitignore`. Never `git add -f` an ignored path to force it in merely
because the user named the path. First show the matching ignore rule and the
risk. Force-add only after the user explicitly confirms that ignored path should
be committed despite the rule; for local config or secret-like paths, treat the
missing file as a scope blocker until that confirmation exists. When unsure why
a path is or isn't showing up, ask git directly:

```sh
git check-ignore -v <path>     # prints the .gitignore rule and line, or nothing
```

## State what you left out

A file you deliberately left untracked is a decision the next agent cannot see.
If you leave plans, specs, generated dirs, or anything ambiguous out of the
commit, say so in your summary ("left `specs/` and `evals/<name>/workspace/`
untracked"). Otherwise a later step may commit it blindly — or delete it
thinking it was junk.

## If a stray slipped into the index

Unstage without touching the working tree, then re-add only what belongs:

```sh
git restore --staged <path>          # repo has commits (HEAD exists)
git rm --cached -r -- <path>         # unborn repo (no HEAD yet), or remove from index
```

`git rm --cached` removes the path from the index but keeps the file on disk —
the right tool for "I accidentally staged a generated dir." Re-inspect with
`git diff --cached --name-only` afterward.

## Quick checklist

- Looked at every category, including `--ignored` and `--untracked-files=all`?
- Does the staged set form one logical change, with tests/docs included and
  unrelated edits split out?
- Are generated, workspace, lock, plan/spec, agent-state, and secret paths kept
  out (and not force-added)?
- Did you note any deliberately-left-untracked paths in your summary?
