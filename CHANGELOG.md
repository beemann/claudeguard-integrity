# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-20

Both halves of `source-encoding` stopped being enumerations. Neither change fixed a
missing entry in a list; both removed the list.

### Changed

- **BREAKING (config)** — `sourceEncoding[].extensions` is deprecated. A rule that
  still declares one is honoured, but now also reports how many readable files it left
  unread, because a narrowed scan must not be able to read as a clean one. **Migration:
  delete `extensions`.** The rule then reads every file under its roots and declares
  what it skips. On the project this engine came from, the old list had left 144 of 532
  tracked files unread — eleven of them executable, including the git hooks that run on
  every push, the Dockerfile, and the shell runner of the gate itself. None was dirty;
  all were invisible.
- **Coverage is derived from the runtime's Unicode tables**, not from a block list: the
  control, format and separator categories plus `Default_Ignorable_Code_Point`.
  Measured against the tables, the old list missed **3802 code points** Unicode marks
  invisible — among them the reserved tail of the Tags plane (`U+E0080-E0FFF`),
  fourteen variation selectors (`U+FE00-FE0D`), `U+061C`, and the above-BMP format
  controls at `U+1D173-1D17A` and `U+13430-1343F`. The named families remain, but only
  so a finding names the real threat; a test walks the whole code-point space to prove
  none can claim a character the coverage rule would let through.
- **The presentation-selector allowance narrows from sixteen code points to two.**
  `U+FE0E`/`U+FE0F` earn it — without them the gate cries over every emoji in a README
  and gets switched off. The other fourteen are a documented smuggling alphabet, one
  byte per selector, and are refused.
- Every check result now carries what it **declined to read**, and every surface prints
  it next to `filesScanned`. "Scanned 388, said nothing about 144" is how a gate reads
  green while being blind.
- `package.json` and the plugin manifest no longer disagree about the version.

### Added

- **`binaryExtensions`** — declared non-text files are skipped and counted. An
  *undeclared* binary is read and fails loudly, because that is where a payload would
  sit. The check never asks git which files are binary: git calls a file binary
  precisely when it holds a NUL, which is the symptom being hunted.
- **`dataPaths`** — fixtures whose content *is* an attack sample keep their bytes,
  under a reduced rule that still forbids control characters and invalid UTF-8. The
  reduction applies only to inert data extensions, so a script under such a path keeps
  the full rule.
- **`allowancesByExtension`** — extra code points tolerated per extension (prose
  hyphenates, code does not). Bounded by construction: an allowance for a control,
  bidi, line-separator, tag or variation-selector code point is **refused as a
  finding**, so the escape hatch cannot be widened into a door.
- **Invalid UTF-8 is a finding.** Malformed bytes decode to a perfectly visible
  `U+FFFD`, so a scan that trusted the decode could be walked straight past. Every file
  is now compared against a re-encode of its own decoding.
- **Symlinks are reported, not followed** — bytes whose real home the diff never showed.

### Fixed

- `U+2061-2064`, the invisible maths operators, were not detected. They arrive by
  pasting rendered maths out of a chat, which lands one between a function name and its
  bracket; the rule stopped at `U+2060`.
- `U+200E`/`U+200F` were a recorded exception on the grounds that they are directional
  *markers* rather than overrides. In authored source an escape says the same thing
  visibly, and the measured cost of forbidding them was zero, so the exception is gone.

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
