# agency-gates: copy this into the CODE repository, on day one

This folder was placed in the engagement workspace at bootstrap. It does nothing here.
It has to be copied into the repository that holds the application code, the moment that
repository exists, and before the first route is written.

```bash
cd <the code repo>
cp -r <engagement>/agency-gates/scripts          .
cp -r <engagement>/agency-gates/qa               .          # merge if qa/ exists
cp -r <engagement>/agency-gates/.github          .          # merge if .github/ exists
git add scripts qa .github && git commit -m "chore(ci): agency gates at birth"
```

## What each gate refuses

| job | rule | refuses |
|---|---|---|
| `boundaries` | Rule 2 | a route that queries the database itself instead of calling `lib/server` |
| `swallowed` | Rule 20 | a `catch` that turns "cannot tell" into "no" |
| `waterfall` | Rule 31 | independent server reads issued one after another |
| `callers` | Rule 19 | changing a shared computation without naming its callers |
| `claims` | Rule 17, Rule 26 | a PR that claims done with no artefact, or Hebrew with no rendered screenshot |

## The baselines in qa/ are empty ON PURPOSE

Every one of these gates is built on the ratchet (`scripts/lib/ratchet.mjs`), which refuses
only an INCREASE against a committed baseline. On an existing codebase the baseline holds
hundreds of entries, because a gate that refuses every pull request is a gate everyone
routes around.

**Here the baselines are empty, so there is no increase to be tolerated and every violation
is refused.** A new project owes nothing to its own history.

Do not "fix" a red gate by regenerating the baseline. Regenerating is for LOWERING it after
a real fix. If you genuinely have to record a violation, the commit that does it says why,
in the commit message, and somebody reads it.

## When a gate reports DID NOT RUN

Exit code 2, and the reason is printed by name. That is Rule 20 working, not a pass and not
a flake. Read the reason: a missing baseline file, an unparseable baseline, a missing merge
base. Fix the precondition. Never make a DID NOT RUN green by deleting the step.

## Where the real copies live

`~/.claude/shared/scripts/`. Each has a `.test.mjs` beside it. A fix belongs there first and
is re-copied out; a fix made only inside one project is a fork nobody will find again.
