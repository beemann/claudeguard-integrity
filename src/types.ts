/**
 * ClaudeGuard Integrity — engine core types (build brief §4.1).
 *
 * A deterministic AST integrity gate over ALREADY-MERGED code (not a diff). The
 * engine is a pure function of (repo root, config) → Finding[]; every surface
 * (CLI now, MCP/skill in Phase B) is a thin wrapper over it. These types are
 * project-agnostic — every project-specific rule lives entirely in the injected
 * config (build brief D4), never here.
 */

/** One rule violation, with enough evidence to locate and explain it. */
export interface Finding {
  /** The check rule that produced this finding (e.g. `no-invisible-characters`). */
  readonly checkId: string;
  /** Repo-relative POSIX path of the offending file. */
  readonly file: string;
  /** 1-based line of the offending token. */
  readonly line: number;
  /** The exact token that tripped the rule (e.g. `Date.now`, `new Date`). */
  readonly token: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/**
 * The forbidden-token set for a purity closure (build brief §4.4). Split by AST
 * shape so matching is exact and content-blind: a token is only ever matched
 * against real code nodes, never comments or string literals (build brief §2.6 —
 * why AST, not regex).
 */
export interface ForbiddenTokens {
  /** Exact module specifiers forbidden as an import / re-export / dynamic import. */
  readonly imports: readonly string[];
  /**
   * Forbidden import *prefixes* — an import whose specifier starts with any of
   * these is flagged (e.g. `["@acme/"]` forbids a whole package family). Generic
   * mechanism for a "this layer may not depend on that family" rule; a project
   * supplies the family. The project this engine was extracted from uses it to
   * machine-enforce that the engine keeps zero coupling to its host codebase —
   * the boundary is a check, not a promise (build brief D4).
   */
  readonly importPrefixes?: readonly string[];
  /** Dotted `identifier.member` references, e.g. `Date.now`, `Math.random`. */
  readonly propertyAccess: readonly string[];
  /** Constructor identifiers forbidden in `new X(...)`, e.g. `Date`. */
  readonly newExpressions: readonly string[];
  /** Bare-call identifiers, e.g. `fetch`, `setTimeout`, `randomUUID`. */
  readonly callExpressions: readonly string[];
}

/**
 * One purity-closure rule: the import-closure of `entryPoints` may not reference
 * any token in `forbidden`. Because the check IS the closure, importing an impure
 * module into a pure entry point drags in its impurity and fires — so a project
 * rule of the form "this advisory layer must never reach the enforcement path"
 * falls out of the closure for free (build brief §4.3).
 */
export interface PurityClosureRule {
  /** Stable rule id, surfaced in findings. */
  readonly id: string;
  /** Repo-relative entry files whose transitive within-repo closure is checked. */
  readonly entryPoints: readonly string[];
  readonly forbidden: ForbiddenTokens;
}

/**
 * One file-invariant rule: properties that must (or must never) be present in the
 * REAL CODE of a single file — the generic `must-contain` / `must-not-contain`
 * mechanism (build brief §4.5). Coarser than a closure, but it holds a load-bearing
 * property of a file that a type system cannot express: a security header that must
 * stay, a sink that must never appear.
 *
 * Matching is over the AST, so a **comment or doc block mentioning the token does
 * not satisfy (or trip) the rule** — the file may document its own invariant
 * without that documentation standing in for the code (build brief §2.6). This is
 * the difference between this check and a grep, and it is the whole point.
 */
export interface FileInvariantRule {
  /** Stable rule id, surfaced in findings. */
  readonly id: string;
  /** Repo-relative POSIX path of the file the invariant holds over. */
  readonly file: string;
  /**
   * Each entry must appear as a substring of at least one literal (string,
   * template, or numeric) in real code — e.g. a CSP directive, a bind address.
   */
  readonly literalsRequired: readonly string[];
  /** No entry may appear as a substring of any literal — e.g. `<script`. */
  readonly literalsForbidden: readonly string[];
  /**
   * Member names forbidden in real code, matched as `x.NAME` or `x["NAME"]` — the
   * shape a DOM/HTML sink takes (e.g. `innerHTML`).
   */
  readonly membersForbidden: readonly string[];
}

/**
 * One source-encoding rule: no source file under `roots` may contain a character
 * that is invisible to a reader but meaningful to a machine.
 *
 * **This is the one check that is deliberately NOT AST-based**, and that is the
 * point. The defect class it holds is invisible to every other tool in the chain:
 * a NUL byte inside a template literal parses fine, type-checks fine, formats
 * fine, and passes every test — while making `git` classify the whole file as
 * BINARY. The file then has no reviewable diff and no blame, so every later change
 * to it ships unreviewed. An AST check cannot see it (the parser has already
 * consumed the byte into a token); only a byte-level scan can.
 *
 * The wider class is the one input-scanning security tools look for in untrusted
 * text (zero-width, bidi overrides — Trojan Source, CVE-2021-42574). Holding it
 * over our own tree closes an embarrassing asymmetry: a tool that detects concealed
 * characters in someone else's input should not be blind to them in its own source,
 * where the payoff (code that reads differently than it compiles) is higher.
 */
export interface SourceEncodingRule {
  /** Stable rule id, surfaced in findings. */
  readonly id: string;
  /** Repo-relative directories to walk. `["."]` means the whole repo. */
  readonly roots: readonly string[];
  /** File extensions to scan, including the dot (e.g. `".ts"`). */
  readonly extensions: readonly string[];
  /**
   * Directory names skipped during the walk. Defaults to
   * {@link DEFAULT_EXCLUDED_DIRS} — dependency and build output, which a project
   * neither authors nor reviews.
   */
  readonly excludeDirs?: readonly string[];
}

/** Directory names never walked: not authored here, not reviewed here. */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
];

/** The parametric config an integrated project injects (build brief §4.2). */
export interface IntegrityConfig {
  readonly purityClosures: readonly PurityClosureRule[];
  /** Optional — a project may hold file invariants without any purity closure. */
  readonly fileInvariants?: readonly FileInvariantRule[];
  /** Optional — byte-level source hygiene over whole directory trees. */
  readonly sourceEncoding?: readonly SourceEncodingRule[];
}

/** The outcome of one check over the repo. */
export interface CheckResult {
  readonly checkId: string;
  readonly findings: readonly Finding[];
  /** How many within-repo files this check actually parsed — the non-inert proof. */
  readonly filesScanned: number;
}

/** A check bound to its config, ready to run against a repo root. */
export type Check = (root: string) => CheckResult;

/** The aggregate result of a run over every configured check. */
export interface RunResult {
  readonly results: readonly CheckResult[];
  /** Every finding, flattened across checks. */
  readonly findings: readonly Finding[];
  /** True iff no check produced a finding. */
  readonly ok: boolean;
}
