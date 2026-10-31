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
 *
 * **A denylist matches spellings, not behaviour.** `Date.now` is matched as written;
 * `globalThis.Date.now`, `Date["now"]`, `const D = Date; D.now()` and a namespace
 * import of an unlisted module are other spellings of the same thing, and none of
 * them is in this set. Names, not bindings, are matched, so a local function called
 * `fetch` is reported too. For a closure whose purity is load-bearing, declare
 * {@link PurityClosureRule.allowed} as well: an allowlist refuses whatever it does not
 * name, however it is spelled.
 */
export interface ForbiddenTokens {
  /**
   * Exact module specifiers forbidden in any value load — `import`, `export … from`,
   * `import x = require(…)`, `import(…)`, `require(…)`, `import.meta.require(…)`.
   */
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
  /**
   * Optional allowlist mode. When present, the closure may reach the host
   * environment only through what this names; everything else is a finding, however
   * it is spelled. Held in addition to {@link forbidden}, never instead of it.
   */
  readonly allowed?: AllowedSurface;
  /**
   * Repo-relative files in which a module load with a COMPUTED specifier is
   * intended — a program loading its own configuration, a plugin host. Such a load
   * is still not followed: it is declared here instead of reported, and counted in
   * the check's `skipped` list, so the report says what the closure does not cover.
   *
   * A listed file that holds no computed load is a finding: a stale exception would
   * pre-authorise the next one, unseen. Only computed loads are covered; a path that
   * resolves to nothing is never excusable.
   */
  readonly computedLoadsAllowedIn?: readonly string[];
}

/**
 * What a closure may reach outside its own code, by allowlist (allowlist mode of
 * {@link PurityClosureRule}).
 *
 * A **global** is any name a file uses without declaring it — resolved by the
 * TypeScript binder, so a local `const fetch = …` is not a global and
 * `globalThis.fetch` is a use of `globalThis`. `import.meta` counts as a global named
 * `"import.meta"`.
 *
 * Incompleteness here costs precision, never soundness: a pure global missing from
 * the list is reported until someone adds it, in review. That is the opposite failure
 * direction from {@link ForbiddenTokens}, where a missing entry is a silent pass.
 */
export interface AllowedSurface {
  /** Globals the closure may use in any position: `Object`, `JSON`, `Map`. */
  readonly globals: readonly string[];
  /**
   * Globals the closure may use ONLY as `Name.member` (or `Name["member"]`) with a
   * listed member: `{ Math: ["min", "max"] }`. Any other use — an alias, a computed
   * key, passing `Math` itself — would reach every member, and is a finding.
   */
  readonly globalMembers: Readonly<Record<string, readonly string[]>>;
  /**
   * Third-party and runtime modules the closure may load, by exact specifier
   * (`"zod"`, `"node:path"`). They are trusted, not inspected: the walker never reads
   * them. Path, workspace and `#` specifiers are internal and are walked instead.
   */
  readonly externalImports: readonly string[];
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
   * Each entry must appear in at least one literal in real code — e.g. a CSP
   * directive, a bind address. A string or template literal matches when it
   * CONTAINS the entry; a numeric literal only when it EQUALS it, so `405` is not
   * satisfied by `14050`.
   */
  readonly literalsRequired: readonly string[];
  /** No literal may match an entry, by the same rule — e.g. `<script`. */
  readonly literalsForbidden: readonly string[];
  /**
   * Member names forbidden in real code — the shape a DOM/HTML sink takes (e.g.
   * `innerHTML`). Matched as `x.NAME`, `x["NAME"]`, `` x[`NAME`] ``, an object-literal
   * key (`Object.assign(el, { NAME: … })`) and a destructured name
   * (`const { NAME } = el`). A key computed at run time (`el[k]`, `Reflect.set`) is
   * not visible to a syntactic check.
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
  /**
   * DEPRECATED (decision #182) — an opt-in extension list is a place to hide. When
   * set, the rule still honours it, but it also reports how many files under its
   * roots it left unread, because a narrowed scan must not be able to read as a
   * clean one. Omit it and the rule reads every file that is not declared binary.
   */
  readonly extensions?: readonly string[];
  /**
   * Extensions whose content is not reviewable text and is therefore skipped —
   * images, fonts, archives, compiled output. Defaults to
   * {@link DEFAULT_BINARY_EXTENSIONS}. Skips are COUNTED and reported: a file the
   * gate did not read is a fact the operator gets to see, never a silence.
   *
   * A binary file with an undeclared extension is read and fails loudly. That is
   * deliberate — an undeclared binary is exactly where a payload would sit.
   */
  readonly binaryExtensions?: readonly string[];
  /**
   * Repo-relative path prefixes holding attack or trace FIXTURES — data whose whole
   * point is to carry the real bytes of an attack (a concealment corpus, a captured
   * transcript). Files under these paths are still read and counted, under a reduced
   * rule: control characters and invalid UTF-8 are still forbidden, because a fixture
   * that git treats as binary is as unreviewable as any other file, but the
   * concealment alphabet itself is allowed — it is the sample.
   *
   * The reduction applies only to inert data extensions
   * ({@link DEFAULT_DATA_EXTENSIONS}); a script or source file under one of these
   * paths gets the full rule, so "hide it in the corpus" is not a route.
   */
  readonly dataPaths?: readonly string[];
  /**
   * Directory names skipped during the walk. Defaults to
   * {@link DEFAULT_EXCLUDED_DIRS} — dependency and build output, which a project
   * neither authors nor reviews.
   */
  readonly excludeDirs?: readonly string[];
  /**
   * Extra code points tolerated in files of a given extension, on top of tab/LF/CR
   * and the presentation selectors the check always allows — e.g.
   * `{ ".md": [0x00ad] }`, because prose may legitimately hyphenate and code may not
   * (decisions #181/#182).
   *
   * Bounded by construction: an allowance is REFUSED, as a finding, for any code
   * point in the hard families — controls, bidi controls, line separators, tag
   * characters and variation selectors. Those have no legitimate authored use at any
   * extension, so no config can talk its way into them. There is also no way to
   * allow a RANGE; each code point is listed and therefore reviewed.
   */
  readonly allowancesByExtension?: Readonly<Record<string, readonly number[]>>;
}

/**
 * Directory names never walked: not authored here, not reviewed here. Matched by
 * NAME at any depth, which is what a monorepo needs (`packages/<name>/node_modules`), and
 * which is also why every skipped directory is reported — a source directory that
 * happens to be called `build` would otherwise go unread in silence (decision #182).
 */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
];

/**
 * Extensions whose bytes are not reviewable text. Skipping these is the ONLY reason
 * the check declines to read a file, and it says so in its report.
 */
export const DEFAULT_BINARY_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".svgz",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".jar",
  ".wasm",
  ".node",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".class",
  ".pyc",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
];

/**
 * Inert data extensions: the only files a {@link SourceEncodingRule.dataPaths} entry
 * may reduce the rule for. Anything executable or compilable under a data path keeps
 * the full rule.
 */
export const DEFAULT_DATA_EXTENSIONS: readonly string[] = [
  ".txt",
  ".jsonl",
  ".csv",
  ".tsv",
  ".log",
  ".eml",
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
  /**
   * How many files and directories the check declined to read, and why, one entry per
   * reason (e.g. `"binary extension"`, `"excluded directory"`). A check that skips
   * without saying so can report green for the very thing it did not look at, so
   * every surface prints this next to `filesScanned` (decision #182).
   */
  readonly skipped?: readonly { readonly reason: string; readonly count: number }[];
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
