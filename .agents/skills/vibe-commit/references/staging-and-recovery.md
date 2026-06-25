# Staging, the Re-Verify Gate, and Recovery

Staging is not committing. Between `git add` and `git commit` there is a cheap
window to catch the large majority of commit mistakes before they become
history. This reference covers the verification gate, partial staging, and how
to recover when something still goes wrong — always preferring the
least-destructive fix.

## The mandatory re-verify gate

After staging and before every commit, confirm what you are actually about to
commit. Looking from several angles catches different failures:

```sh
git diff --cached --name-only   # exact file list — are the right files in, strays out?
git diff --cached --stat        # volume sanity — does the size match intent?
git diff --cached               # read the hunks — is this the change you meant?
git diff --cached --check       # trailing whitespace / line-ending / conflict markers
git status --short              # what remains unstaged, and is that intentional?
```

The file list alone is not enough — read the actual staged diff. A rename, a
partial hunk, or an accidental deletion shows up in the diff, not the name list.
`--check` is worth the half-second: trailing whitespace and CRLF issues
otherwise surface at a commit hook or in review and force an amend cycle.

This gate appeared as the most universally emphasized discipline across mined
sessions; commits made *without* it were the most common source of "wrong files
in history."

## Partial staging: only some hunks of a file

When one file mixes in-scope and out-of-scope changes, stage just the relevant
hunks:

```sh
git add -p <file>        # interactively pick hunks (y/n/s to split, e to edit)
git apply --cached <patch>   # apply a specific patch to the index only
```

Partial staging can fail silently — a split that didn't split, a hunk you
skipped that you needed. So treat `git add -p` as needing the same gate: after
selecting, run `git diff --cached <file>` to confirm exactly the intended hunks
landed, and `git diff <file>` to confirm the rest stayed out. Put both commands
in the verification sequence before committing; do not replace the unstaged diff
with a prose note or `git status`, because those do not prove the local-only
hunk still has the intended content.

## Know your branch and base

Before committing, confirm context so you do not land on the wrong branch or
amend the wrong base:

```sh
git branch --show-current
git log -1 --oneline                              # the commit you might extend
git rev-list --left-right --count <base>...HEAD   # prints "<behind>  <ahead>"; right column = your commits past base (0 = nothing to amend)
```

If HEAD is 0 commits ahead of the branch base, there is nothing of yours to
amend — a new commit is the only option. (See `history-and-trailers.md` for the
amend-vs-new decision.)

## Recovery ladder — least destructive first

Match the fix to the mistake. Climb only as far as you must:

```sh
# 1. Unstage (working tree untouched)
git restore --staged <file>      # one file        (HEAD exists)
git reset HEAD                   # everything
git rm --cached -r -- <path>     # unborn repo (no HEAD), or a path NOT yet in HEAD; on a tracked path this STAGES A DELETION

# 2. Undo the last commit, keep the work
git reset --soft HEAD~1          # uncommit, changes stay staged
git reset HEAD~1                 # uncommit, changes stay in working tree (unstaged)

# 3. Fix a just-made local commit in place (only if unpushed)
git commit --amend --no-edit                 # re-stage fix, keep message
git commit --amend --no-edit --trailer '…'   # add/repair a trailer

# 4. Full restart of UNPUSHED work only — destructive, last resort
git reset --hard <known-base>    # to a SHA you captured and the user confirmed
```

Guidance:

- `git restore --staged` needs a HEAD; in an unborn repo it fails with "could
  not resolve HEAD" — use `git rm --cached` instead.
- `git reset --soft HEAD~1` is the workhorse for "undo the commit, I'll re-split
  or fix it" — the changes are preserved and still staged.
- `git reset --hard` and force-push *discard* work. Use `--hard` only to return
  to a SHA you captured beforehand and the user confirmed, and never force-push
  a shared branch (see the safety boundary in `SKILL.md`).
- Before any complex or risky operation, capture the current state so you can
  return to it: note `git rev-parse HEAD`, or `git branch backup/<name>` /
  `git stash push -u`.

## Stash hazards

Stash is useful for isolating or parking work, but it has sharp edges seen
repeatedly in the data:

```sh
git stash push -u -m 'wip: <marker>'   # include untracked (-u); label it
git stash list                         # confirm what exists before pop/drop
git stash pop stash@{0}                # apply + drop the top stash
```

- `git stash push` with no local changes prints "No local changes to save" and
  creates **nothing**. If you assume a new stash exists and then operate on
  `stash@{0}`, you act on the wrong (older) stash. Capture
  `git rev-parse refs/stash` before, compare after, and verify your message
  marker.
- When resolving a conflict from `git stash pop` (or a rebase), you must
  `git add <file>` the resolved file *before* dropping the stash — otherwise the
  resolution is lost. Resolve, add, verify, then drop.
- Applying several stashes during a restore: apply all and verify all before you
  drop any. Dropping as you go leaves asymmetric loss if a later apply fails.

## Transient errors are not fatal

A transient `index.lock: Read-only file system`, a momentary permission error,
or a sandbox I/O hiccup is retryable. Retry the same command (escalating
environment permissions if the setup requires it) rather than deleting
`index.lock` by hand or hacking the index — those workarounds can corrupt state.

## Merge semantics, when relevant

If the task involves integrating a branch, choose the merge shape on purpose
rather than accepting the default:

```sh
git merge --ff-only <branch>     # keep history linear; fails safely if it can't
git merge --no-ff <branch>       # preserve the feature-branch structure
git diff --stat <base>..<head>   # confirm the merge carried all intended changes
```

A silent fast-forward can erase branch structure you wanted; an accidental merge
commit can clutter a history you wanted linear. Pick one and verify.

## Verify after every mutating step

Do not assume a git operation succeeded silently. After staging, committing,
resetting, stashing, or merging, confirm with `git status -s`, `git show --stat`,
or `git log -1` that the result matches what you intended.
