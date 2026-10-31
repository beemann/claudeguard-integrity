# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No change to what the engine reports; documentation and the engine's own self-check.

### Changed

- **The engine's own determinism check runs in allowlist mode.** The README says a
  denylist alone is not enough for a closure whose purity is load-bearing, and the
  self-check was a denylist — `globalThis.Date.now()` in the engine would have passed
  it. `integrity.config.self.ts` now names everything the engine reaches (measured by
  running the closure against `PURE_SURFACE` and reading what it refused), and refuses
  the rest.

### Documentation

- README: install as a Claude Code plugin (marketplace commands and the `settings.json`
  form), a note on pinning the engine version across a findings-changing update, the
  allowlist self-check under design rule 3, and the test suites that exist since 0.3.0.
- CONTRIBUTING: the first two rules as the README now states them; `lift-readiness`
  described as what it checks — it had claimed a check on host rule names that only a
  host's private test performs.

## [0.4.0] - 2026-10-31

An external review named three spellings of the clock that `purity-closure` did not
see. A probe built from them found twenty-two, and four import forms the closure walk
dropped without a word. Both are the mistake 0.2.0 removed from `source-encoding`: a
list standing in for the property it was meant to hold.

### Fixed

- **BREAKING (findings)** — **a closure no longer ends in silence.** The walk
  followed `import`, `export … from` and string-literal `import()` only. It now also
  follows `import x = require(…)`, `require(…)`, `import.meta.require(…)` and
  template-literal `import()`; resolves TypeScript's emitted-extension substitution
  (`./x.js` → `./x.ts`, `.mjs` → `.mts`, `.cjs` → `.cts`) and the `.mts`, `.cts`,
  `.js`, `.mjs`, `.cjs` and `index.tsx` candidates; and **reports** every load it
  cannot follow — a path that resolves to nothing, a computed specifier, a `#`
  subpath import, a `data:` or `http(s):` URL. Before this, a project on
  `moduleResolution: "nodenext"`, where every relative import ends in `.js`, had a
  closure of exactly its entry points, and a green verdict. **Migration:** fix the
  specifier, or declare an intended computed load with `computedLoadsAllowedIn`.
- **Every load form is checked against `forbidden.imports`**, where only `import`,
  `export … from` and literal `import()` were.
- **A type-only import of a forbidden module is no longer a finding.** It is erased
  at build; the walk already ignored it as an edge, and the scan now uses the same
  walk, so there is one definition of a value load instead of two.
- **`file-invariants`, BREAKING (findings)** — `membersForbidden` also matches a
  template-literal key, an object-literal key (`Object.assign(el, { innerHTML })`) and
  a destructured name. A numeric literal now matches an entry only when **equal** to
  it: `14050` no longer satisfies a required `405`.

### Added

- **Allowlist mode for `purity-closure`** — `allowed: { globals, globalMembers,
  externalImports }`, held in addition to `forbidden`. Every global the closure uses
  and every third-party module it loads must be named. "Uses a global" is the
  TypeScript binder's answer, so an alias, `globalThis.X`, an element access, a
  destructuring, a `class … extends X`, a shorthand property and a `typeof` probe are
  each a use of the global they start from, while a local that shadows a global is
  not. JSX is refused, because its runtime import appears in no source line.
  Allowances for `globalThis`, `global`, `self`, `window`, `eval` and `Function` are
  refused as findings, and so is a name allowed both freely and member-restricted.
  `PURE_SURFACE` ships as the generic starting point. Against the review's probe:
  **22 of 22** spellings reported, where the denylist reports 3.
- `computedLoadsAllowedIn` — files whose computed module load is intended (a program
  loading its own config). The load is counted in the check's `skipped` list instead
  of reported; a declaration with no such load behind it is a finding.
- `moduleReferences`, `unfollowedImports`, `isPathSpecifier` and
  `isExternalSpecifier` are exported.

### Deprecated

- `unresolvedWorkspaceImports` — use `unfollowedImports`; its `reason: "workspace"`
  subset is the old answer.

### Changed

- **README design rule 1 is restated.** It promised zero false positives, and the
  denylist matches names, not bindings: a local function called `fetch` is reported.
  The rule now says what is actually held — a finding always points at real code that
  matches the rule as written — and the README states the threat model the gate was
  built for: honest drift, not an adversary with commit access.

### Notes

- Not reachable by any static check, and not claimed: a reflective route that never
  names a global (`[].constructor.constructor("…")`) and a method on a value that
  reads the host (`toLocaleString`). A host project can add a runtime instrument for
  what actually executes; the project this engine came from did.
- Measured on that project: in allowlist mode its decision-path closure used exactly
  two globals outside `PURE_SURFACE`, both deliberate and now named in its config.
  Both surfaces of this engine load their config by computed path, now declared.
  Closure sizes 12, 12 and 1 files; zero findings; run time within noise of 0.3.0.

### First published here, unrecorded until now

0.3.0 was cut but never published, and two changes from that cycle never reached
this file. Both ship to the public repository for the first time in 0.4.0.

- **BREAKING (findings)** — **a rule that constrains nothing is never a pass.** A
  purity closure that forbids nothing (and, from 0.4.0, declares no allowlist), a
  file invariant that requires and forbids nothing, a source-encoding rule with no
  roots: each is refused with a finding, decided from the rule's declaration before
  any file is read. And a check that parsed zero files and found nothing is refused
  too — an empty scan is never a pass. Measured on the project this engine came
  from, emptying a rule's token set had reported `OK` at exit 0 over the same file
  count as a healthy run.
- **The closure walker is verified over a complete input space.** The traversal
  (`closureOver`, exported) is a pure function of entry points and an edge reader,
  checked against an independent breadth-first fixpoint and four closure laws over
  every directed graph on up to four nodes in the test suite, and over all
  33 554 432 graphs on five nodes by `bun run bench:closure-laws`. No output
  contract changed.

## [0.3.0] - 2026-10-07

Two ways a purity closure could end early without saying so. The engine already
refused an unresolvable **entry point** (0.1.0); it did not refuse an unresolvable
**edge**, and it resolved package sub-paths against a directory it had guessed.

### Fixed

- **A workspace sub-path now resolves against the package's source root.** The
  previous derivation was `dirname(dirname(entry))`, which hard-codes "the entry is
  exactly two levels deep": for an entry at `<pkg>/src/index.ts` it looked for
  `<pkg>/sub.ts` and never `<pkg>/src/sub.ts` — where a package declaring
  `exports["."] = "./src/index.ts"` actually keeps its source — and for an entry at
  `<pkg>/index.ts` it resolved sub-paths against the package's **parent**. Both roots
  are now derived, the package directory being the nearest ancestor holding a
  `package.json`, searched no further up than the repo root.

### Added

- **BREAKING (findings)** — an import that names a workspace package but resolves to
  no file is now **reported**, where it was previously indistinguishable from a
  third-party import and silently not traversed. `resolveSpecifier` returns
  `undefined` for both cases, so a closure could end mid-walk while claiming to cover
  what lay beyond. Under-approximation is the direction that reports green, and this
  is the same defect as an unresolvable entry point one edge further in, so it gets
  the same answer. **A consumer whose repository contains such an import will see new
  findings and a non-zero exit.** That is the bug surfacing, not a new rule: the
  closure was never covering what it said it covered.
- `isWorkspaceSpecifier` and `unresolvedWorkspaceImports` are exported, so a host can
  ask the same question the purity check now asks.

### Notes

- Measured on the project this engine came from: **zero** workspace sub-path imports
  exist and every package declares only `"."`, so no closure there was being
  shortened. The branch was dormant — wrong for its first real user rather than wrong
  today. Closure sizes and findings over that repository are unchanged by this release
  (12, 10 and 1 files; zero findings).


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
