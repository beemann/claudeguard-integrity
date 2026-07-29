import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { importClosure, loadWorkspacePackages, parseSourceFile } from "../graph";
import type { CheckResult, Finding, ForbiddenTokens, PurityClosureRule } from "../types";

/**
 * Flagship check #1 — `purity-closure` (build brief §4.3). Asserts that the import
 * closure of a rule's entry points references no forbidden token. Deterministic and
 * content-blind: it walks the AST, so a token appearing in a comment or a string
 * literal (typically a file's own doc block describing the invariant it holds) is
 * invisible to it — the exact reason regex was rejected (build brief §2.6).
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
 * undefined if it is allowed. Both import and re-export / dynamic-import forms use
 * this one predicate so the rule is applied identically wherever a specifier appears.
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

/** Walk one file's AST and collect findings for the forbidden set. */
function scanFile(
  sf: ts.SourceFile,
  file: string,
  rule: PurityClosureRule,
  forbidden: ForbiddenTokens,
  findings: Finding[],
): void {
  const push = (node: ts.Node, token: string, message: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ checkId: rule.id, file, line: line + 1, token, message });
  };

  const visit = (node: ts.Node): void => {
    // Forbidden import / re-export / dynamic import (exact specifier or prefix).
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const reason = forbiddenImportReason(node.moduleSpecifier.text, forbidden);
      if (reason !== undefined) {
        push(node.moduleSpecifier, node.moduleSpecifier.text, reason);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const reason = forbiddenImportReason(node.moduleSpecifier.text, forbidden);
      if (reason !== undefined) {
        push(node.moduleSpecifier, node.moduleSpecifier.text, reason);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        const reason = forbiddenImportReason(arg.text, forbidden);
        if (reason !== undefined) {
          push(arg, arg.text, reason);
        }
      }
    }

    // `identifier.member` reads — clock / entropy through a member access.
    if (ts.isPropertyAccessExpression(node)) {
      const dotted = dottedName(node);
      if (dotted !== undefined && forbidden.propertyAccess.includes(dotted)) {
        push(node, dotted, `forbidden reference "${dotted}" — non-deterministic`);
      }
    }

    // `new X(...)` construction.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbidden.newExpressions.includes(node.expression.text)
    ) {
      push(
        node,
        `new ${node.expression.text}`,
        `forbidden construction "new ${node.expression.text}(...)"`,
      );
    }

    // Bare call `x(...)` — timer / clock / entropy / I/O identifier.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      forbidden.callExpressions.includes(node.expression.text)
    ) {
      push(node, node.expression.text, `forbidden call "${node.expression.text}(...)"`);
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
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
  const files = importClosure(root, rule.entryPoints, workspace);
  for (const file of files) {
    const sf = parseSourceFile(resolve(root, file));
    scanFile(sf, file, rule, rule.forbidden, findings);
  }
  return { checkId: rule.id, findings, filesScanned: files.length };
}
