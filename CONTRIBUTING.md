# Contributing

Thanks for looking. This is a small, deliberately narrow tool, and the constraints
below are the product — a contribution that relaxes one of them is a regression even
if every test passes.

## The three rules a change must not break

1. **A finding is never a guess.** It points at real code that matches the rule as
   written — never at a comment, a string or a type. A gate that cries wolf gets
   switched off, and a switched-off gate catches nothing. "Mostly right" is not a
   category here. (This rule once read "zero false positives"; the denylist matches
   names, not bindings, so that overclaimed. Say what a rule matches, exactly.)
2. **Never silently inert.** An unresolved entry point, a missing root, a rule that
   matched nothing, an import the closure cannot follow — each is a **finding**, never
   a skip; a skip that is intended is declared and counted in the report. The worst
   failure this tool can have is reporting green because it stopped checking, because
   that is indistinguishable from success at a glance.
3. **Deterministic, offline, read-only.** No clock, no network, no model, no write
   path. Same tree plus same config must give the same findings on any machine, and a
   gate that can fix what it judges is no longer a gate.

## Adding a check

A check is a function `(root, rule) => CheckResult`. To add one:

1. Add the rule type to `src/types.ts` and an optional field on `IntegrityConfig`.
2. Write the check in `src/checks/`. It must report `filesScanned` honestly — that
   number is what lets a reader tell a pass from an absence.
3. Bind it in `buildChecks()` in `src/runner.ts`.
4. Test it, including the inert case: assert that a rule pointed at something missing
   **fails** rather than passing quietly.

Prefer AST matching over regex. The reason is concrete: the file a rule protects
usually documents its own invariant in a comment, and a regex is satisfied by that
prose — so deleting the real code while keeping the comment would pass. The one
deliberate exception is `source-encoding`, which must see bytes precisely because by
the time an AST exists the byte is already inside a token.

## Tests

```bash
bun install
bun test test/
bun run src/cli.ts --config integrity.config.self.ts --root .   # the dogfood run
bun run bench:closure-laws   # on demand: the closure walker over every 5-node graph
```

The dogfood run holds the engine's own closure in **allowlist mode**. If your change
makes the engine reach something new — a module, a global, a member of `process` —
that run fails, and the fix is a reviewed line in `integrity.config.self.ts` saying
why, not a workaround.

`test/lift-readiness.test.ts` guards this package's boundary: no import escapes the
directory, every bare import is a node builtin or a declared dependency, the tsconfig
inherits nothing, the licence ships, every file the manifest promises exists, no file
points outside the directory, and none names it by its path inside a host repository.
Tests count — this whole directory is the repository. If you add a file, that test is
the one most likely to tell you something you did not expect.

## Style

- TypeScript strict. No `any`, no `@ts-ignore`.
- Comments explain **why**, not what. If a line encodes a lesson, say what went wrong.
- No invisible characters in source — write them as escape sequences. This project
  fails its own CI otherwise, which is the intended joke.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
