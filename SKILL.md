---
name: claudeguard-integrity
description: Deterministic integrity gate over already-merged code — AST purity closures, file invariants, and a byte-level source-encoding scan. Use when asked to "check integrity", "run the integrity gate", after a refactor that moved or renamed load-bearing files, or when a change touches a module whose correctness the type system cannot express. Report-only — never edits files.
---

# ClaudeGuard Integrity — the gate that does not judge

This skill runs a **deterministic** static-analysis gate over the whole merged tree.
It is the sibling of `claudeguard`, and the difference is the point:

| | `claudeguard` | `claudeguard-integrity` |
|---|---|---|
| decides by | an LLM reading a diff | mechanical analysis (AST + bytes) |
| scope | the diff | the whole tree, merged code |
| when | pre-merge | in your test command, so also pre-push and CI |
| failure mode it covers | intent, policy, judgement | drift, and what review cannot see |

**Your judgement is not an input here.** Run it, read the findings, report them. Do
not argue with a finding, and never "explain away" one you believe is wrong — if a
rule is wrong, the fix is a change to the config, not a verdict you talk past.

## Running it

```bash
bun run src/cli.ts --config <path-to>/integrity.config.ts [--root <dir>]
```

Exit `0` = clean, `1` = at least one finding, `2` = could not run. Those last two are
deliberately different: **"never looked" must never be reported as "found nothing".**

Most projects wrap this in a script (`integrity:check` or similar) and put it in the
same command as lint and tests. If the project has one, prefer it — it carries the
right `--config`.

An MCP surface exists for mid-session use:

```bash
bun run src/mcp.ts --config <path-to>/integrity.config.ts
```

Its tool `check_integrity` **takes no arguments**: the ruleset and the root are pinned
at startup, because a caller who can pass a lenient config can mint a green verdict
without touching the judged code. If you find yourself wanting to narrow the scope of
a run, that is the gate working, not a limitation.

## Reading the output

Each check reports **how many files it scanned and what it did not read**, and those
numbers matter as much as the verdict:

```
  decide-stays-pure: 12 file(s) scanned, 0 finding(s)
  no-invisible-characters: 544 file(s) scanned, 0 finding(s) [not read: 15 declared
    binary extension, 12 excluded directory, 67 read as declared attack/trace data]
```

**A check that scanned nothing is not a check that passed.** A rule pointed at a
renamed file once produced 0 files, 0 findings and exit 0 — green because it had
stopped checking. If a count looks implausibly small for what the rule claims to
cover, say so; that is a finding about the gate itself.

A finding names the file, the line, the check and the exact token:

```
  src/render.ts:77 [no-invisible-characters] U+0000 — control character U+0000 in source…
```

## The three checks

- **`purity-closure`** — the transitive import closure of an entry point is held to
  a rule. Because the check *is* the closure, importing an impure module into a pure
  one drags it in and fires. Two modes:
  - *denylist* (`forbidden`) — forbidden tokens (`Date.now`, `fetch`, a module). It
    matches **spellings**: `globalThis.Date.now()` is not `Date.now` to it.
  - *allowlist* (`allowed`) — every global and third-party module the closure uses
    must be named; the binder decides what is a global, so no spelling escapes it.

  An import the closure cannot follow — a missing path, a computed specifier, a `#`
  or URL import — is a finding. A declared computed load (`computedLoadsAllowedIn`)
  shows up in the `not read` list instead: read it as what the closure did not cover.
- **`file-invariants`** — literals that must exist in one file, literals that must
  never appear, members that must never be referenced. Matched over **AST nodes
  only**, so a comment mentioning the token neither satisfies nor trips it.
- **`source-encoding`** — no file may hold a character invisible to a reviewer. Both
  halves of the rule are **derived, not enumerated**, because both times the hole was
  the list itself:
  - *which characters* — the runtime's Unicode tables (control, format and separator
    categories plus `Default_Ignorable_Code_Point`). The block list it replaced missed
    3802 invisible code points. Allowed: tab, newline, carriage return, and the
    `U+FE0E`/`U+FE0F` presentation selectors.
  - *which files* — every file under the roots, with no `extensions` allow-list. On the
    project this engine came from, that list had left 144 of 532 tracked files unread,
    eleven of them executable, including the git hooks and the gate's own runner.
    Declared binary extensions, excluded directories and symlinks are the only
    declines, and each is **counted in the report**. Invalid UTF-8 is a finding: a
    malformed byte decodes to a visible `U+FFFD`, so a scan that trusts the decode can
    be walked straight past.
  - *exceptions are bounded* — `allowancesByExtension` lets prose keep its soft hyphen,
    but an allowance for a control, bidi, tag or variation-selector code point is
    refused as a finding. `dataPaths` reduces the rule for fixtures whose content *is*
    an attack sample, never for a script under them.

  The only non-AST check, and the reason it exists is that a raw NUL byte once passed
  lint, prettier, `tsc`, a full test suite and an LLM diff gate — while making `git`
  treat the file as binary, i.e. removing the review surface entirely.

## When to reach for it unprompted

- After a refactor that **moved or renamed** files a rule points at — that is the
  silent-greening case, and it is the one nobody notices.
- After touching a module whose correctness the type system cannot express: a
  security boundary, a renderer that must escape, a decision path that must stay
  deterministic.
- Before pushing, if you changed source. It is usually already in the project's
  check command, so running that is enough.

## Hard constraints

- **Never edit files to make a finding go away.** Report it; the human decides.
- **Never re-run with a narrowed config** to get a clean result.
- **Never report "clean" from memory** — quote the run.
