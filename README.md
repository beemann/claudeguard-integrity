# ClaudeGuard Integrity

A **deterministic integrity gate over already-merged code**. It parses your tree —
ASTs and raw bytes — and answers a fixed set of questions with a mechanical yes or
no. No model sits in the decision path, so there is no opinion to talk it out of.

MIT licensed. No network, no telemetry, no clock, no write path.

## What it actually checks

Three checks, each aimed at a class of defect that survives a green test suite.

### `purity-closure` — "this code path stays clean, all the way down"

Give it an entry point and a set of forbidden tokens (`Date.now`, `Math.random`,
`fetch`, an import prefix, …). It walks the **transitive import closure** of that
entry point and fails if any reachable file references one.

The closure is the whole idea. You are not asserting that one file is pure; you are
asserting that everything it can reach is. Import an impure helper three layers down
and the check fires, because the helper's tokens are now in the closure. Rules of the
form *"the enforcement path must never reach the advisory layer"* stop being a
convention somebody remembers and become a property of the graph.

### `file-invariants` — "this file keeps the thing that makes it safe"

Literals that must appear in a file, literals that must never appear, member names
that must never be referenced. A security header that has to survive every refactor;
a DOM sink that must never show up.

Matching is over **AST nodes only**, and that is deliberate. The file protecting an
invariant almost always documents it in a doc block — so a `grep` for the CSP string
is satisfied by the comment describing the CSP. Delete the real header, keep the
comment, and the regex is happy. This check reads code, not prose.

### `source-encoding` — "nothing here is invisible to the reviewer"

A byte scan for characters a human cannot see but a machine acts on. Coverage is
**derived from the runtime's Unicode tables**, not from a list of blocks: the control,
format and separator categories plus `Default_Ignorable_Code_Point` — the property
that means "a renderer draws nothing here". That covers NUL and the C1 controls, bidi
overrides, isolates and marks, zero-width characters and the invisible operators next
to them, the BOM, invisible line separators, Hangul fillers, the Tags plane and the
variation selectors.

Tab, newline and carriage return are fine — they show up in a diff. So are `U+FE0E`
and `U+FE0F`, the presentation selectors, because without them the gate cries over
every emoji in a README and gets switched off; the other fourteen selectors are a
documented smuggling alphabet and are not allowed. Anything else invisible in source
gets written as an escape.

**The file set is derived too.** The rule reads every file under its roots — there is
no `extensions` allow-list, because an opt-in list is where a payload hides. Measured
on the project this engine came from, an extension list left 144 of 532 tracked files
unread, eleven of them executable: the git hooks that run on every push, the
Dockerfile, the hardware-signing example scripts, and the shell runner of this very
gate. The only reasons the rule may decline to read a file are declared and **counted
in its report**:

- a declared binary extension (an *undeclared* binary is read and fails loudly);
- an excluded directory, reported by path, since exclusions match by name at any depth;
- a symlink, which is reported rather than followed.

It does not ask git which files are binary: git calls a file binary precisely when it
holds a NUL, which is the symptom being hunted.

Invalid UTF-8 is a finding, not a pass — malformed bytes decode to `U+FFFD`, a
perfectly visible character, so every file is compared against a re-encode of its own
decoding.

A rule may tolerate extra code points per extension with `allowancesByExtension`
(e.g. `{ ".md": [0x00ad] }` — prose hyphenates, code does not). The mechanism is
bounded: an allowance for a control, bidi control, line separator, tag character or
variation selector is **refused as a finding**, so the escape hatch cannot be widened
into a door. `dataPaths` reduces the rule for attack fixtures whose content *is* the
sample — still read, still counted, still forbidden from holding a control character.

The list-based version of this check missed 3802 code points Unicode marks invisible
(decision #181) and could not see 27 % of the tree (decision #182). Both times the
hole was not a missing entry — it was the list.

This one exists because of a specific defect. A raw NUL byte inside a template
literal passed lint, passed the formatter, passed `tsc`, passed the entire test suite,
and passed an LLM reviewing the diff. Every one of those tools reads the file as text,
and a NUL is legal text. What it did do was make `git` classify the file as **binary** —
no reviewable diff, no `git blame`. From that commit on, every change to that file
shipped unreviewed, and nothing in the chain said a word.

The other families are the Trojan Source class
([CVE-2021-42574](https://nvd.nist.gov/vuln/detail/CVE-2021-42574)): the code the
reviewer reads is not the code the compiler sees.

## How it complements ClaudeGuard

[ClaudeGuard](https://github.com/beemann/claudeguard) is the sibling: an LLM reading a
diff before merge, judging it against rulesets written in prose. They are not
competitors and neither replaces the other, because **they fail in opposite
directions.**

|  | ClaudeGuard | ClaudeGuard Integrity |
| --- | --- | --- |
| decides by | a model reading a diff | AST + byte analysis |
| looks at | what **changed** | what **is**, in the whole tree |
| runs | pre-merge, on a PR | post-merge, in your test command |
| good at | intent, judgement, policy in prose | invariants, drift, the unreviewable |
| fails by | missing what a reviewer would miss | only seeing what you configured |
| verdict | PASS / WARN / FAIL, with reasoning | findings with file, line, token |

Three concrete ways the pairing beats either alone:

**A diff gate cannot see what did not change.** Rename a file that a rule points at
and the rule silently matches nothing. The diff is clean, so a diff-based gate has
nothing to object to — while the invariant has quietly stopped being enforced. This
tool re-checks the whole tree every run and reports how many files each check parsed,
so "0 files scanned" is visible instead of reading as success.

**A model reading text cannot see bytes.** The NUL byte above is the worked example.
An LLM is handed the diff as text; the byte is inside the text; it reads as nothing
at all. A reviewer who "looks carefully" produces a confident, wrong answer. That is
not a prompt problem — it is the wrong instrument.

**Prose rules and mechanical rules protect different things.** "Don't hand authority
to attacker-controlled input" needs judgement, and a model is the right tool. "The
import closure of `decide.ts` contains no clock" needs exactness, and a model is the
wrong one. Ask each question of the tool that can answer it.

Run ClaudeGuard on the pull request. Run this in the same command as your tests.

## Install

Not on npm. Clone it, or vendor the directory into your repo:

```bash
git clone https://github.com/beemann/claudeguard-integrity
cd claudeguard-integrity && bun install
```

Requires [Bun](https://bun.sh). Two runtime dependencies: the TypeScript compiler API
(for the AST checks) and the MCP SDK (for the server surface).

## Configure it

The engine ships **mechanisms**; the rules are yours. Every surface takes
`--config <path>` pointing at a module that default-exports an `IntegrityConfig`.
Start from [`integrity.config.example.ts`](integrity.config.example.ts):

```ts
import type { IntegrityConfig } from "./src/types";
import { FORBIDDEN_NONDETERMINISM } from "./src/tokens";

const config: IntegrityConfig = {
  purityClosures: [
    { id: "decide-stays-pure", entryPoints: ["src/decide.ts"], forbidden: FORBIDDEN_NONDETERMINISM },
  ],
  fileInvariants: [
    {
      id: "render-keeps-its-csp",
      file: "src/render.ts",
      literalsRequired: ["default-src 'none'"],
      literalsForbidden: ["<script"],
      membersForbidden: ["innerHTML"],
    },
  ],
  sourceEncoding: [{ id: "no-invisible-characters", roots: ["."], extensions: [".ts", ".md"] }],
};

export default config;
```

This split is why the tool can be public while your invariants stay private: nothing
in `src/` knows what any of those ids mean. Your config is where your project's
knowledge accumulates, and it never has to leave your repository.

Adding a rule is a config change. Adding a rule *kind* is a check module plus one line
in `runner.ts` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run it

### CLI — for CI and pre-push

```bash
bun run src/cli.ts --config integrity.config.ts [--root <dir>]
```

| exit | meaning |
| --- | --- |
| `0` | clean |
| `1` | at least one finding |
| `2` | could not run |

`1` and `2` are deliberately different. "Found nothing" and "never looked" must never
share an exit code.

Output names the count before the verdict:

```
  decide-stays-pure: 12 file(s) scanned, 0 finding(s)
  no-invisible-characters: 544 file(s) scanned, 0 finding(s) [not read: 15 declared
    binary extension, 12 excluded directory, 67 read as declared attack/trace data]
claudeguard-integrity: OK — no findings across 2 check(s).
```

### MCP server — for an agent, mid-session

```bash
bun run src/mcp.ts --config integrity.config.ts [--root <dir>]
```

One tool, `check_integrity`, **taking no arguments at all**. The ruleset and the tree
are pinned when the server starts; the caller chooses neither.

That is a security property, not an ergonomic one, and it was measured rather than
assumed. An earlier draft accepted the config path per call. Over one tree holding a
NUL byte, the real ruleset returned `1 FINDING` and a substituted empty one returned
`OK — no findings across 0 check(s)` — a green verdict minted without touching the
judged code and without running anything hostile. Whoever may choose the rules may
choose the answer, so there is nothing left to choose. Passing an argument anyway is
refused loudly rather than ignored, and a config declaring zero checks is refused at
startup.

Both surfaces call the same `run(config, root)` and render through the same
`report.ts`. A second surface must never become a second opinion.

### Claude Code skill

Copy [`SKILL.md`](SKILL.md) into `.claude/skills/claudeguard-integrity/`. It tells the
agent when to reach for the gate unprompted, and how to read `filesScanned` as part of
the verdict rather than trusting "OK" on its own.

## Design rules

1. **Zero false positives.** A gate that cries wolf gets switched off, and a
   switched-off gate catches nothing. If a check cannot be exact, it does not ship.
2. **Never silently inert.** An unresolved entry point or a missing root is a
   *finding*, not a skip. Reporting green because you stopped checking is the worst
   failure available, since it is indistinguishable from success.
3. **Deterministic, offline, read-only.** Same tree plus same config gives the same
   findings on any machine. There is no write path: a gate that can fix what it judges
   is no longer a gate.

Rule 3 is **checked, not asserted**. `integrity.config.self.ts` holds an
`engine-determinism` closure over both entry points, forbidding clocks, entropy,
network and timers across everything they can reach — file reads stay allowed, because
reading the tree under judgement is this program's input rather than a side channel.
Seeding a `Date.now()` three modules deep fails the run. A tool built on the premise
that invariants must be checked rather than promised has no business holding its own
as a promise.

## Tests

```bash
bun test test/
bun run src/cli.ts --config integrity.config.self.ts --root .   # the gate, on itself
```

The suite includes `test/lift-readiness.test.ts`, which holds this package to being
self-contained: no source file imports outside the directory, every bare import is a
node builtin or a *declared* dependency, the tsconfig inherits nothing, and every file
the manifest promises to ship exists. It is a test rather than a claim precisely
because that is the kind of property that quietly stops being true.

## Not built, deliberately

Dead and orphaned export detection, contract drift, circular dependencies. Each is
useful; each is a different tool. Bolting them on here would trade design rule 1 for
coverage, and that trade is how gates end up disabled.

## Licence

[MIT](LICENSE).
