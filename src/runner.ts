import { runFileInvariants } from "./checks/file-invariants";
import { runPurityClosure } from "./checks/purity-closure";
import { runSourceEncoding } from "./checks/source-encoding";
import type { Check, CheckResult, Finding, IntegrityConfig, RunResult } from "./types";
import { vacuousRules } from "./vacuity";

/**
 * The engine (build brief §3): a pure function of (config, repo root) → RunResult.
 * Every surface — CLI now, MCP / skill in Phase B — is a thin wrapper over this.
 * No I/O beyond reading the repo's own source, no clock, no network: the tool is
 * itself a deterministic static analysis (build brief §7).
 */

/** Bind each configured rule to a runnable check. */
export function buildChecks(config: IntegrityConfig): Check[] {
  return [
    ...config.purityClosures.map((rule) => (root: string) => runPurityClosure(root, rule)),
    ...(config.fileInvariants ?? []).map((rule) => (root: string) => runFileInvariants(root, rule)),
    ...(config.sourceEncoding ?? []).map((rule) => (root: string) => runSourceEncoding(root, rule)),
  ];
}

/**
 * A clean result over zero files is not a pass either.
 *
 * The static half of this lives in {@link vacuousRules}: a rule that forbids
 * nothing can be refused before any file is read. The other half is only
 * observable at run time — a rule that forbids plenty but whose closure or tree
 * comes out empty measured nothing, and said so in a count nobody gates on
 * (decision #132 surfaced the count; it did not make it decide).
 *
 * Only a result that is otherwise *clean* is converted. A check that scanned
 * nothing and still produced a finding has already explained itself, and a second
 * finding over the same cause would make the report argue with itself.
 */
function emptyScanFinding(result: CheckResult): Finding | undefined {
  if (result.filesScanned > 0 || result.findings.length > 0) {
    return undefined;
  }
  return {
    checkId: result.checkId,
    file: "(no file reached)",
    line: 1,
    token: "filesScanned",
    message: `check "${result.checkId}" parsed 0 files and found nothing — an empty scan is never a pass. The rule's target has moved, or its tree is empty.`,
  };
}

/**
 * Run every configured check against `root` and aggregate the findings.
 *
 * Two refusals ride along the per-check results, and both say the same thing in
 * different tenses: a gate that measured nothing must not be able to report OK.
 * A vacuous rule is refused from its declaration, an empty scan from its outcome.
 * Each is attached to the check it belongs to, so the report names the rule rather
 * than appending an orphan.
 */
export function run(config: IntegrityConfig, root: string): RunResult {
  const vacuous = vacuousRules(config);
  const results = buildChecks(config).map((check) => {
    const result = check(root);
    const refusal = vacuous.get(result.checkId) ?? emptyScanFinding(result);
    return refusal === undefined ? result : { ...result, findings: [...result.findings, refusal] };
  });
  const findings = results.flatMap((result) => result.findings);
  return { results, findings, ok: findings.length === 0 };
}
