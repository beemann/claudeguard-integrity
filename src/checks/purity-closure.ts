import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { ambientReferences, type AmbientReference } from "../ambient";
import {
  importClosure,
  isExternalSpecifier,
  loadWorkspacePackages,
  moduleReferences,
  parseSourceFile,
  unfollowedImports,
  type UnfollowedImport,
} from "../graph";
import { GLOBALS_NEVER_ALLOWED } from "../tokens";
import type {
  AllowedSurface,
  CheckResult,
  Finding,
  ForbiddenTokens,
  PurityClosureRule,
} from "../types";

/**
 * Flagship check #1 — `purity-closure` (build brief §4.3). Asserts that the import
 * closure of a rule's entry points references no forbidden token. Deterministic and
 * content-blind: it walks the AST, so a token appearing in a comment or a string
 * literal (typically a file's own doc block describing the invariant it holds) is
 * invisible to it — the exact reason regex was rejected (build brief §2.6).
 *
 * Two modes, and they fail in opposite directions. The DENYLIST (`forbidden`) matches
 * spellings: whatever it does not list passes, however close a cousin. The ALLOWLIST
 * (`allowed`) refuses every global and every third-party module it does not name, so
 * what it misses costs a finding nobody needed, never a silent pass.
 */

/** The dotted `identifier.member` name of a property access, or undefined. */
function dottedName(node: ts.PropertyAccessExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) {
    return `${node.expression.text}.${node.name.text}`;
  }
  return undefined;
}

/**
 * The reason a module specifier is forbidden — an exact match against
 * `forbidden.imports`, or a prefix match against `forbidden.importPrefixes` — or
 * undefined if it is allowed. Every load form uses this one predicate so the rule is
 * applied identically wherever a specifier appears.
 */
function forbiddenImportReason(specifier: string, forbidden: ForbiddenTokens): string | undefined {
  if (forbidden.imports.includes(specifier)) {
    return `forbidden import of "${specifier}" — opens a side channel`;
  }
  const prefix = forbidden.importPrefixes?.find((candidate) => specifier.startsWith(candidate));
  if (prefix !== undefined) {
    return `forbidden import of "${specifier}" — couples to "${prefix}*" (boundary violation)`;
  }
  return undefined;
}

type Push = (position: number, token: string, message: string) => void;

/** Denylist: forbidden module loads and the forbidden member / constructor / call names. */
function scanForbidden(sf: ts.SourceFile, forbidden: ForbiddenTokens, push: Push): void {
  // Every value load form, from the same walk the closure uses — so a type-only
  // import is exempt here exactly as it is not an edge there.
  for (const ref of moduleReferences(sf)) {
    if (ref.specifier !== undefined) {
      const reason = forbiddenImportReason(ref.specifier, forbidden);
      if (reason !== undefined) {
        push(ref.position, ref.specifier, reason);
      }
    }
  }

  const visit = (node: ts.Node): void => {
    // `identifier.member` reads — clock / entropy through a member access.
    if (ts.isPropertyAccessExpression(node)) {
      const dotted = dottedName(node);
      if (dotted !== undefined && forbidden.propertyAccess.includes(dotted)) {
        push(node.getStart(sf), dotted, `forbidden reference "${dotted}" — non-deterministic`);
      }
    }

    // `new X(...)` construction.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbidden.newExpressions.includes(node.expression.text)
    ) {
      const token = `new ${node.expression.text}`;
      push(node.getStart(sf), token, `forbidden construction "${token}(...)"`);
    }

    // Bare call `x(...)` — timer / clock / entropy / I/O identifier.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbidden.callExpressions.includes(node.expression.text)
    ) {
      const name = node.expression.text;
      push(node.getStart(sf), name, `forbidden call "${name}(...)"`);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Why one use of a global is outside the allowlist, or undefined when it is inside. */
function ambientViolation(
  ref: AmbientReference,
  allowed: AllowedSurface,
  members: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  if (allowed.globals.includes(ref.name)) {
    return undefined;
  }
  const allowedMembers = members.get(ref.name);
  if (allowedMembers === undefined) {
    return `"${ref.name}" is a global this closure does not allow — it reaches the host environment by name`;
  }
  if (ref.member === undefined) {
    return (
      `"${ref.name}" is allowed only as ${ref.name}.{${allowedMembers.join(", ")}}, and this use is ` +
      "not a member read — an alias, a computed key or the bare value reaches every member"
    );
  }
  if (!allowedMembers.includes(ref.member)) {
    return `"${ref.name}.${ref.member}" is not an allowed member of ${ref.name}`;
  }
  return undefined;
}

/**
 * Allowlist: every third-party load and every use of a global must be named in
 * `allowed`, and JSX — whose compiled form imports a runtime the walk never sees — may
 * not appear at all.
 */
function scanAllowed(
  sf: ts.SourceFile,
  allowed: AllowedSurface,
  workspace: ReadonlyMap<string, string>,
  push: Push,
): void {
  for (const ref of moduleReferences(sf)) {
    if (
      ref.specifier !== undefined &&
      isExternalSpecifier(ref.specifier, workspace) &&
      !allowed.externalImports.includes(ref.specifier)
    ) {
      push(
        ref.position,
        ref.specifier,
        `"${ref.specifier}" is a module this closure does not allow — it is never read by the ` +
          "walk, so allowing it is a statement of trust",
      );
    }
  }

  const members = new Map(Object.entries(allowed.globalMembers));
  for (const ref of ambientReferences(sf)) {
    const violation = ambientViolation(ref, allowed, members);
    if (violation !== undefined) {
      const token = ref.member === undefined ? ref.name : `${ref.name}.${ref.member}`;
      push(ref.node.getStart(sf), token, violation);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      push(
        node.getStart(sf),
        "JSX",
        "JSX compiles to calls into a runtime module that appears in no import, so the " +
          "closure cannot account for it",
      );
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * An allowlist that grants a skeleton key is refused: each of
 * {@link GLOBALS_NEVER_ALLOWED} reaches every other global or evaluates code. So is a
 * name listed both freely and member-restricted, because the free entry would void
 * the restriction without anyone seeing it.
 */
function refusedAllowances(rule: PurityClosureRule, allowed: AllowedSurface): Finding[] {
  const at = rule.entryPoints[0] ?? "(no entry point declared)";
  const refuse = (token: string, message: string): Finding => ({
    checkId: rule.id,
    file: at,
    line: 1,
    token,
    message,
  });
  const restricted = Object.keys(allowed.globalMembers);
  const refusals = [...allowed.globals, ...restricted]
    .filter((name) => GLOBALS_NEVER_ALLOWED.includes(name))
    .map((name) =>
      refuse(
        name,
        `allowance for "${name}" refused — it reaches every global or evaluates code, so it ` +
          "would re-open everything this allowlist closes",
      ),
    );
  for (const name of restricted.filter((candidate) => allowed.globals.includes(candidate))) {
    refusals.push(
      refuse(
        name,
        `"${name}" is allowed both freely and as ${name}.{…} — the free entry silently voids ` +
          "the member restriction; keep one",
      ),
    );
  }
  return refusals;
}

/** The finding for one load the closure walk could not follow. */
function unfollowedFinding(rule: PurityClosureRule, entry: UnfollowedImport): Finding {
  const why: Record<UnfollowedImport["reason"], string> = {
    path: "is a path that resolves to no file",
    workspace: "names a workspace package but resolves to no file",
    "subpath-import": "is a package subpath import, which this engine does not resolve",
    computed: "is computed at run time, so no static walk can know which file it loads",
    url: "loads code from a URL, which is not in the repository",
  };
  return {
    checkId: rule.id,
    file: entry.file,
    line: entry.line,
    token: entry.specifier,
    message:
      `"${entry.specifier}" ${why[entry.reason]} — the closure ends here while claiming to ` +
      "cover what lies beyond. An import the walk cannot follow is never a pass.",
  };
}

/**
 * Run one purity-closure rule against a repo root. Builds the closure, walks every
 * file in it, and returns the findings plus the file count.
 *
 * An entry point that does not resolve to a file is a FINDING, not a skip. The
 * closure walk skips what it cannot resolve, so without this an entry point that
 * was renamed or moved would take the whole rule with it: zero files in the
 * closure, zero findings, exit 0 — the gate reporting green precisely because it
 * had stopped checking. A rule that cannot find its subject has failed, not passed.
 */
export function runPurityClosure(root: string, rule: PurityClosureRule): CheckResult {
  const workspace = loadWorkspacePackages(root);
  const findings: Finding[] = [];
  for (const entry of rule.entryPoints) {
    const abs = resolve(root, entry);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      findings.push({
        checkId: rule.id,
        file: entry,
        line: 1,
        token: entry,
        message:
          "entry point not found — this closure is unchecked. Update the rule if the " +
          "file moved; an unresolvable entry point is never a pass.",
      });
    }
  }
  if (rule.allowed !== undefined) {
    findings.push(...refusedAllowances(rule, rule.allowed));
  }

  const files = importClosure(root, rule.entryPoints, workspace);
  for (const file of files) {
    const sf = parseSourceFile(resolve(root, file));
    const push: Push = (position, token, message) => {
      const { line } = sf.getLineAndCharacterOfPosition(position);
      findings.push({ checkId: rule.id, file, line: line + 1, token, message });
    };
    scanForbidden(sf, rule.forbidden, push);
    if (rule.allowed !== undefined) {
      scanAllowed(sf, rule.allowed, workspace, push);
    }
  }

  // A load the walk cannot follow means the closure stopped short of what it claims
  // to cover, and under-approximation is the direction that reports green. Same
  // defect as an unresolvable entry point above, one edge further in, so it gets the
  // same answer (DEBT D-3, then every unfollowable form in 0.4.0) — unless the rule
  // declares that file's computed load, in which case it is counted, not hidden.
  const declared = new Set(rule.computedLoadsAllowedIn ?? []);
  const excused = new Set<string>();
  let declaredLoads = 0;
  for (const entry of unfollowedImports(root, files, workspace)) {
    if (entry.reason === "computed" && declared.has(entry.file)) {
      excused.add(entry.file);
      declaredLoads += 1;
    } else {
      findings.push(unfollowedFinding(rule, entry));
    }
  }
  for (const file of [...declared].filter((candidate) => !excused.has(candidate))) {
    findings.push({
      checkId: rule.id,
      file,
      line: 1,
      token: "computedLoadsAllowedIn",
      message:
        "declared as holding a computed module load, but the closure has none in this file " +
        "— a stale exception would pre-authorise the next one. Remove the entry.",
    });
  }
  const skipped =
    declaredLoads === 0
      ? []
      : [{ reason: "declared computed load, not followed", count: declaredLoads }];
  return { checkId: rule.id, findings, filesScanned: files.length, skipped };
}
