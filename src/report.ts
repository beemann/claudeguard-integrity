import type { Finding, RunResult } from "./types";

/**
 * The one place a run is turned into words (decision #143).
 *
 * Every surface — CLI, MCP, and anything added later — renders from here. They may
 * differ in *plumbing* (the CLI splits stdout from stderr; the MCP server returns a
 * single string) but never in *wording*, because two surfaces that describe the same
 * `RunResult` differently are two answers, and a reader comparing them cannot tell
 * which one the gate actually meant.
 *
 * That was not hypothetical: the CLI said `12 file(s) in closure` while the MCP
 * server said `12 file(s) scanned` for the identical number. "In closure" was also
 * simply wrong for `source-encoding`, which walks directories and computes no
 * closure at all — so the duplicated wording was not just inconsistent, it was
 * inaccurate on one of the three checks.
 */

/**
 * One line per check, always including how many files it actually parsed.
 *
 * `filesScanned` is not decoration: a rule pointed at a renamed file once scanned 0
 * files, found 0 findings and exited 0 — green because it had stopped checking
 * (decision #132). The count is the only thing in the output that can tell a passing
 * check apart from an absent one, so it travels with every verdict, in every surface.
 */
export function summaryLines(result: RunResult): string[] {
  return result.results.map((check) => {
    const skipped = (check.skipped ?? [])
      .map((entry) => `${String(entry.count)} ${entry.reason}`)
      .join(", ");
    // Skips travel with the count for the same reason the count travels with the
    // verdict (#182): a file the check declined to read is a fact the operator gets
    // to see. "Scanned 388, said nothing about 144" is how a gate reads green while
    // being blind, so there is nowhere in this output for a silent skip to live.
    return (
      `${check.checkId}: ${String(check.filesScanned)} file(s) scanned, ` +
      `${String(check.findings.length)} finding(s)` +
      (skipped === "" ? "" : ` [not read: ${skipped}]`)
    );
  });
}

/** A single finding, with enough evidence to locate it without re-running anything. */
export function formatFinding(finding: Finding): string {
  return (
    `${finding.file}:${String(finding.line)} [${finding.checkId}] ` +
    `${finding.token} — ${finding.message}`
  );
}

/** The headline: what the gate concluded, in one line. */
export function verdictLine(result: RunResult): string {
  return result.ok
    ? `OK — no findings across ${String(result.results.length)} check(s).`
    : `${String(result.findings.length)} FINDING(S):`;
}

/**
 * The whole run as one block of text — the shape a tool result wants, where there is
 * no stdout/stderr split to use. Findings first, then the per-check counts, so the
 * non-inert proof is present whether the verdict is green or red.
 */
export function formatRunResult(result: RunResult): string {
  const summary = summaryLines(result);
  if (result.ok) {
    return [verdictLine(result), ...summary].join("\n");
  }
  return [verdictLine(result), ...result.findings.map(formatFinding), "", ...summary].join("\n");
}
