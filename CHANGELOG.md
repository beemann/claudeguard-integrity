# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-29

First public release. The engine had been running inside a private codebase for two
months before extraction; every check below exists because something got through.

### Added

- **Engine** — a pure function of `(config, repo root) → RunResult`, with no clock, no
  network and no model in the decision path.
- **`purity-closure`** check — the transitive within-project import closure of an entry
  point may not reference a forbidden token. Because the check *is* the closure, an
  impure module imported into a pure one drags in its tokens and fires.
- **`file-invariants`** check — literals that must exist, literals that must not, and
  members that must never be referenced. Matched over AST nodes only, so a doc comment
  quoting the token neither satisfies nor trips the rule.
- **`source-encoding`** check — byte-level scan for characters invisible to a reviewer
  (C0 controls incl. NUL, bidi overrides and isolates, zero-width, BOM).
- **CLI surface** — exit `0` clean, `1` finding, `2` could not run. The last two are
  distinct on purpose: "never looked" must not be reported as "found nothing".
- **MCP surface** — one nullary tool, `check_integrity`. Ruleset and root are pinned at
  server startup; a caller can steer neither.
- **Skill** (`SKILL.md`) — when an agent should reach for the gate unprompted, and how
  to read `filesScanned` as part of the verdict.
- **Every check reports how many files it parsed.** A rule pointed at a renamed file
  once scanned 0 files, found 0 findings and exited 0 — green because it had stopped
  checking. The count is the only thing that tells a passing check from an absent one.
- **`test/lift-readiness.test.ts`** — asserts the package stays self-contained and free
  of host-project rule names, so the boundary is a test rather than a promise.
- **The engine's own determinism is a check, not a claim.** `integrity.config.self.ts`
  runs the gate over this package in CI with an `engine-determinism` closure across
  both entry points: no clock, no entropy, no network, no timers anywhere they can
  reach. File reads stay allowed — reading the judged tree is input, not a side
  channel. Falsified before shipping: a `Date.now()` seeded three modules below an
  entry point fails the run.

### Security

- The MCP tool takes **no arguments**. An earlier draft accepted the config path per
  call; over a tree holding a NUL byte, substituting an empty ruleset turned
  `1 FINDING` into `OK — no findings across 0 check(s)`. A green verdict could be
  minted without touching the judged code and without running anything hostile.
  Whoever may choose the rules may choose the answer.
- A config declaring zero checks is refused at startup rather than served.
- There is no write path on any surface. A gate that can fix what it judges is no
  longer a gate.
