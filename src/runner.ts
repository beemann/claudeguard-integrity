import { runFileInvariants } from "./checks/file-invariants";
import { runPurityClosure } from "./checks/purity-closure";
import { runSourceEncoding } from "./checks/source-encoding";
import type { Check, IntegrityConfig, RunResult } from "./types";

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

/** Run every configured check against `root` and aggregate the findings. */
export function run(config: IntegrityConfig, root: string): RunResult {
  const results = buildChecks(config).map((check) => check(root));
  const findings = results.flatMap((result) => result.findings);
  return { results, findings, ok: findings.length === 0 };
}
