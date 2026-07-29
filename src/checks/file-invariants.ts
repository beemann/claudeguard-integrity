import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { parseSourceFile } from "../graph";
import type { CheckResult, FileInvariantRule, Finding } from "../types";

/**
 * Flagship check #2 — `file-invariants` (build brief §4.5). Holds a load-bearing
 * property of ONE file: literals that must stay present (a security header, a bind
 * address), literals that must never appear, and member names that must never be
 * referenced (an HTML sink).
 *
 * Why this cannot be a grep: the target file typically *documents* its own
 * invariant in a doc comment. A regex is satisfied by that prose, so dropping the
 * real header while leaving the comment would pass. This check harvests only AST
 * literal and member nodes — comments are structurally invisible to it, so the
 * documentation can never stand in for the code (build brief §2.6).
 *
 * Presence checks are coarser than a closure, and deliberately so: they are cheap,
 * zero-FP, and fire on exactly the regression that matters (the header dropped, a
 * sink introduced). They do not prove the header is *correct* — only that the code,
 * not the comment, still carries it.
 */

/** Every literal value in real code: string, template text, and numeric. */
function harvestLiterals(sf: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, node });
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ text: node.text, node });
    } else if (ts.isNumericLiteral(node)) {
      out.push({ text: node.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every member name referenced as `x.NAME` or `x["NAME"]` in real code. */
function harvestMembers(sf: ts.SourceFile): { name: string; node: ts.Node }[] {
  const out: { name: string; node: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      out.push({ name: node.name.text, node });
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      out.push({ name: node.argumentExpression.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Run one file-invariant rule against a repo root. A missing target file is a
 * FINDING, not a skip: a rule pointed at a moved or renamed file would otherwise go
 * quietly green — the invariant would stop being checked at the moment someone
 * relocated the code it protects.
 */
export function runFileInvariants(root: string, rule: FileInvariantRule): CheckResult {
  const abs = resolve(root, rule.file);
  const findings: Finding[] = [];
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    findings.push({
      checkId: rule.id,
      file: rule.file,
      line: 1,
      token: rule.file,
      message:
        "target file not found — the invariant is unchecked. Update the rule if the " +
        "file moved; a missing target is never a pass.",
    });
    return { checkId: rule.id, findings, filesScanned: 0 };
  }

  const sf = parseSourceFile(abs);
  const literals = harvestLiterals(sf);
  const members = harvestMembers(sf);
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const required of rule.literalsRequired) {
    if (!literals.some((literal) => literal.text.includes(required))) {
      findings.push({
        checkId: rule.id,
        file: rule.file,
        line: 1,
        token: required,
        message:
          `required literal "${required}" is absent from real code — a comment ` +
          "mentioning it does not count",
      });
    }
  }

  for (const forbidden of rule.literalsForbidden) {
    for (const literal of literals) {
      if (literal.text.includes(forbidden)) {
        findings.push({
          checkId: rule.id,
          file: rule.file,
          line: lineOf(literal.node),
          token: forbidden,
          message: `forbidden literal "${forbidden}" appears in real code`,
        });
      }
    }
  }

  for (const forbidden of rule.membersForbidden) {
    for (const member of members) {
      if (member.name === forbidden) {
        findings.push({
          checkId: rule.id,
          file: rule.file,
          line: lineOf(member.node),
          token: forbidden,
          message: `forbidden member reference "${forbidden}" — an unescaped sink`,
        });
      }
    }
  }

  return { checkId: rule.id, findings, filesScanned: 1 };
}
