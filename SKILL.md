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

Each check reports **how many files it scanned**, and that number matters as much as
the verdict:

```
  decide-stays-pure: 12 file(s) scanned, 0 finding(s)
  no-invisible-characters: 344 file(s) scanned, 0 finding(s)
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

- **`purity-closure`** — the transitive import closure of an entry point may not
  reference a forbidden token (`Date.now`, `Math.random`, `fetch`, an import prefix).
  Because the check *is* the closure, importing an impure module into a pure one
  drags in its tokens and fires.
- **`file-invariants`** — literals that must exist in one file, literals that must
  never appear, members that must never be referenced. Matched over **AST nodes
  only**, so a comment mentioning the token neither satisfies nor trips it.
- **`source-encoding`** — no source file may hold a character invisible to a
  reviewer: C0 controls (incl. NUL), bidi overrides, zero-width, BOM. The only
  non-AST check, and the reason it exists is that a raw NUL byte once passed lint,
  prettier, `tsc`, a full test suite and an LLM diff gate — while making `git` treat
  the file as binary, i.e. removing the review surface entirely.

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
