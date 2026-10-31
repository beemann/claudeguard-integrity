import type {
  FileInvariantRule,
  Finding,
  IntegrityConfig,
  PurityClosureRule,
  SourceEncodingRule,
} from "./types";

/**
 * Vacuity: a rule that constrains nothing is never a pass.
 *
 * The engine already held this principle in one place. A closure whose entry point
 * has been renamed away reports *"this closure is unchecked … an unresolvable entry
 * point is never a pass"* rather than a clean closure (decision #132). It did not
 * hold it for the other way a rule stops checking — resolving perfectly well and
 * then forbidding nothing.
 *
 * Measured on this repo before the check existed: emptying a purity rule's
 * `forbidden` token set, or a file-invariant rule's `literalsRequired`, left the
 * gate reporting `OK — no findings` over the *same file count* as a healthy run.
 * One of three deliberate blindings was caught. `filesScanned` cannot separate
 * those cases, because the files really were parsed — they were just measured
 * against nothing.
 *
 * **Why this is not self-attestation.** The question "does this rule forbid
 * anything at all?" is answered from the rule's own declaration, before a single
 * file is read, and never from what a scan found. An instrument whose verdict is
 * derived from the output of the thing it validates proves only internal
 * consistency (CLAUDE.md, *Měření před implementací*); this one does not consult
 * the output at all.
 *
 * **Why there is no fixture.** A positive control made of planted violations would
 * need a file holding the very characters `source-encoding` forbids, which this
 * project writes only as escape sequences, never as characters — including in
 * detector fixtures. Synthesising one at run time would mean temporary I/O, and
 * the engine's contract is no I/O beyond reading the repo's own source. Deciding
 * vacuity statically needs neither.
 *
 * **Totality is a compile-time property, not a convention.** {@link RULE_VACUITY}
 * is a mapped type over every rule-bearing key of {@link IntegrityConfig}: adding a
 * rule kind without a vacuity predicate fails the build. Hand-written enumerations
 * are what decisions #181 and #182 had to undo twice.
 */

/** Why a rule constrains nothing, or `undefined` when it constrains something. */
type VacuityReason = string | undefined;

/** The keys of {@link IntegrityConfig} that carry rules. Derived, never listed. */
type RuleKey = {
  [K in keyof IntegrityConfig]-?: NonNullable<IntegrityConfig[K]> extends readonly unknown[]
    ? K
    : never;
}[keyof IntegrityConfig];

function purityVacuity(rule: PurityClosureRule): VacuityReason {
  if (rule.entryPoints.length === 0) {
    return "declares no entry points, so there is no closure to walk";
  }
  const { imports, importPrefixes, propertyAccess, newExpressions, callExpressions } =
    rule.forbidden;
  const forbidden =
    imports.length +
    (importPrefixes?.length ?? 0) +
    propertyAccess.length +
    newExpressions.length +
    callExpressions.length;
  // An allowlist is never vacuous: it refuses every global and module it does not
  // name, so even an empty one constrains the closure.
  if (forbidden === 0 && rule.allowed === undefined) {
    return "forbids no import, member, constructor or call, so every closure satisfies it";
  }
  return undefined;
}

function fileInvariantVacuity(rule: FileInvariantRule): VacuityReason {
  const constraints =
    rule.literalsRequired.length + rule.literalsForbidden.length + rule.membersForbidden.length;
  if (constraints === 0) {
    return "requires nothing and forbids nothing, so every version of the file satisfies it";
  }
  return undefined;
}

function sourceEncodingVacuity(rule: SourceEncodingRule): VacuityReason {
  if (rule.roots.length === 0) {
    return "declares no roots, so there is no tree to walk";
  }
  return undefined;
}

/**
 * One vacuity predicate per rule kind. The mapped type is the totality guarantee:
 * a new rule-bearing key on {@link IntegrityConfig} leaves this literal incomplete
 * and the build fails.
 */
const RULE_VACUITY: {
  readonly [K in RuleKey]: (rule: NonNullable<IntegrityConfig[K]>[number]) => VacuityReason;
} = {
  purityClosures: purityVacuity,
  fileInvariants: fileInvariantVacuity,
  sourceEncoding: sourceEncodingVacuity,
};

/** The rule's declared target, for a finding that can be located without guessing. */
function targetOf(rule: PurityClosureRule | FileInvariantRule | SourceEncodingRule): string {
  if ("file" in rule) {
    return rule.file;
  }
  if ("entryPoints" in rule) {
    return rule.entryPoints[0] ?? "(no entry point declared)";
  }
  return rule.roots[0] ?? "(no root declared)";
}

/**
 * Every configured rule that constrains nothing, keyed by rule id so a caller can
 * attach the finding to the check it belongs to.
 *
 * Iteration is driven by {@link RULE_VACUITY} rather than by a list of keys written
 * here, so a rule kind cannot be skipped. Correlating a key with its own predicate
 * is beyond what the checker can narrow across the union, so the call is made
 * through one explicit cast — the mapped type above has already guaranteed that the
 * predicate reached is the one written for that key.
 */
export function vacuousRules(config: IntegrityConfig): Map<string, Finding> {
  const found = new Map<string, Finding>();
  for (const key of Object.keys(RULE_VACUITY) as RuleKey[]) {
    const predicate = RULE_VACUITY[key] as (rule: unknown) => VacuityReason;
    for (const rule of config[key] ?? []) {
      const reason = predicate(rule);
      if (reason === undefined) {
        continue;
      }
      found.set(rule.id, {
        checkId: rule.id,
        file: targetOf(rule),
        line: 1,
        token: key,
        message: `rule "${rule.id}" ${reason} — a rule that constrains nothing is never a pass. Give it something to check, or delete it.`,
      });
    }
  }
  return found;
}
