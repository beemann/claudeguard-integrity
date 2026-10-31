import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Within-repo import-closure over the AST (build brief §4.3 step 2). Follows only
 * VALUE edges (a `import type` is erased at build and carries no runtime impurity),
 * resolves path and workspace specifiers to repo files, and does NOT follow
 * external (`node:` / npm) specifiers — those are checked, not traversed, by the
 * purity check itself.
 *
 * An edge is every form that loads a module at run time: `import`, `export … from`,
 * `import x = require(…)`, `import(…)`, `require(…)` and `import.meta.require(…)`.
 * A load the walk cannot follow — a path that resolves to nothing, a computed
 * specifier, a URL — is reported by {@link unfollowedImports}, never dropped: a
 * closure that ends early reads exactly like a clean one.
 *
 * File-granularity: a barrel re-export (e.g. `@acme/core` → its `index.ts`)
 * over-approximates by pulling the whole re-exported module. Accepted for the v1
 * TCB (the re-exported core is a pure model); symbol-level closure is future work
 * (build brief §4.3 precision limit).
 */

/** Normalise an absolute path to a repo-relative POSIX path. */
function toRepoRelative(root: string, absPath: string): string {
  return relative(root, absPath).replaceAll("\\", "/");
}

/** Parse a file into a TS AST. `setParentNodes = true` so `getStart()` works. */
export function parseSourceFile(absPath: string): ts.SourceFile {
  return ts.createSourceFile(
    absPath,
    readFileSync(absPath, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
}

/**
 * Map each workspace package name to the absolute path of its entry file, read
 * from each `packages/<pkg>/package.json` `exports["."]` (falling back to `src/index.ts`).
 * Mirrors `scripts/check-tier-boundaries.ts` `loadPackages` (build brief §9).
 */
export function loadWorkspacePackages(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) {
    return map;
  }
  for (const entry of readDirNames(packagesDir)) {
    const pkgJsonPath = join(packagesDir, entry, "package.json");
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    const json = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      name?: string;
      exports?: Record<string, string>;
    };
    if (json.name === undefined) {
      continue;
    }
    const dot = typeof json.exports?.["."] === "string" ? json.exports["."] : undefined;
    const entryRel = dot ?? "src/index.ts";
    map.set(json.name, resolve(root, "packages", entry, entryRel));
  }
  return map;
}

/** Directory child names (non-recursive), or [] if unreadable. */
function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Is this import declaration type-only (erased at build)? */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) {
    return false; // side-effect import `import "x"` — runtime
  }
  if (clause.isTypeOnly) {
    return true;
  }
  if (clause.name !== undefined) {
    return false; // default binding — value
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    return false; // `* as ns` — value
  }
  return bindings.elements.every((element) => element.isTypeOnly);
}

/** Is this re-export type-only? */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return true;
  }
  const clause = node.exportClause;
  if (clause !== undefined && ts.isNamedExports(clause)) {
    return clause.elements.every((element) => element.isTypeOnly);
  }
  return false; // `export * from …` — value
}

/**
 * One run-time module load, located so a finding can point at it.
 *
 * `specifier` is the literal the load names, or `undefined` when the specifier is
 * computed (`import(name)`, `` require(`./${x}`) ``) — a load no static walk can
 * follow. `written` is the specifier as it appears in source either way.
 */
export interface ModuleReference {
  readonly specifier: string | undefined;
  readonly written: string;
  readonly position: number;
}

/** Is this call a module load — `import(…)`, `require(…)` or `import.meta.require(…)`? */
function isLoadCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) {
    return true;
  }
  if (ts.isIdentifier(callee)) {
    return callee.text === "require";
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "require" &&
    ts.isMetaProperty(callee.expression) &&
    callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * Every VALUE module load in a file, in source order. The one visitor: the closure
 * walk, the unfollowed-import report and the purity check's import rules all derive
 * from it, because two copies of this walk would be two definitions of "value edge",
 * and the closure and the reporting would drift apart exactly where it matters.
 */
export function moduleReferences(sf: ts.SourceFile): ModuleReference[] {
  const refs: ModuleReference[] = [];
  const literal = (node: ts.StringLiteralLike): void => {
    refs.push({ specifier: node.text, written: node.text, position: node.getStart(sf) });
  };
  const argument = (arg: ts.Expression | undefined, site: ts.Node): void => {
    if (arg !== undefined && ts.isStringLiteralLike(arg)) {
      literal(arg);
      return;
    }
    refs.push({
      specifier: undefined,
      written: arg === undefined ? "(no specifier)" : arg.getText(sf),
      position: (arg ?? site).getStart(sf),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) {
        literal(node.moduleSpecifier);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) {
        literal(node.moduleSpecifier);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      if (!node.isTypeOnly) {
        argument(node.moduleReference.expression, node);
      }
    } else if (ts.isCallExpression(node) && isLoadCall(node)) {
      argument(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

function valueSpecifiers(sf: ts.SourceFile): string[] {
  return moduleReferences(sf).flatMap((ref) =>
    ref.specifier === undefined ? [] : [ref.specifier],
  );
}

/** The first candidate path that exists as a file, or undefined. */
function firstExistingFile(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Extensions an extensionless specifier may mean, in the order TypeScript tries
 * them, then the plain-JavaScript ones a runtime also loads. A `.mts` or `.js`
 * module is as much a part of the closure as a `.ts` one.
 */
const SCRIPT_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * TypeScript's output-to-source substitution: a specifier naming the file the
 * compiler will EMIT (`./x.js`) means the source beside it (`./x.ts`). Every project
 * on `moduleResolution: "nodenext"` must write relative imports this way, so a
 * resolver without the substitution reads such a project's closure as its entry
 * point alone.
 */
const SOURCES_OF_EMITTED: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);

/**
 * Is `specifier` a path rather than a package name — relative, absolute, or a
 * `file:` URL? Node's rule rather than a prefix test: a first segment of `.` or `..`
 * makes a relative path; `.x` is a (malformed) package name.
 */
export function isPathSpecifier(specifier: string): boolean {
  const firstSegment = specifier.split("/", 1)[0];
  return (
    firstSegment === "." ||
    firstSegment === ".." ||
    specifier.startsWith("file:") ||
    isAbsolute(specifier)
  );
}

/** Does `specifier` load code from a URL that no repository file holds? */
function isUrlSpecifier(specifier: string): boolean {
  return ["data:", "http:", "https:"].some((scheme) => specifier.startsWith(scheme));
}

/**
 * Is `specifier` a third-party or runtime module — neither a path, nor a package
 * subpath import (`#x`), nor a URL, nor a workspace package? These, and only these,
 * are checked by the purity rule instead of walked.
 */
export function isExternalSpecifier(
  specifier: string,
  workspace: ReadonlyMap<string, string>,
): boolean {
  return (
    !isPathSpecifier(specifier) &&
    !specifier.startsWith("#") &&
    !isUrlSpecifier(specifier) &&
    !isWorkspaceSpecifier(specifier, workspace)
  );
}

/**
 * The files a path may name, most specific first.
 *
 * A specifier with an explicit extension names that file when it exists — that is
 * what a runtime loads — and otherwise its TypeScript source ({@link
 * SOURCES_OF_EMITTED}). An extensionless one is tried with each script extension,
 * then as written, then as a directory index. A specifier that can only mean a
 * directory (`.`, `..`, a trailing `/`) is tried as an index alone, because `./`
 * from `src/a.ts` means `src/index.ts`, never a sibling `src.ts`.
 */
function pathCandidates(base: string, directoryOnly: boolean): string[] {
  const indexes = SCRIPT_EXTENSIONS.map((extension) => join(base, `index${extension}`));
  if (directoryOnly) {
    return indexes;
  }
  const extension = extname(base);
  const sources = SOURCES_OF_EMITTED.get(extension);
  if (sources !== undefined) {
    const stem = base.slice(0, base.length - extension.length);
    return [base, ...sources.map((source) => `${stem}${source}`)];
  }
  return [...SCRIPT_EXTENSIONS.map((candidate) => `${base}${candidate}`), base, ...indexes];
}

/**
 * The absolute base a path specifier points at, or undefined when it cannot point
 * anywhere. Only a malformed `file:` URL can fail; it is returned as unresolved, and
 * {@link unfollowedImports} reports it rather than letting the closure skip it.
 */
function pathBase(specifier: string, fromFileAbs: string): string | undefined {
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return undefined;
    }
  }
  return resolve(dirname(fromFileAbs), specifier);
}

/**
 * Resolve a module specifier to an absolute repo file, or undefined if it is
 * external (`node:` / npm) or cannot be resolved within the repo.
 */
export function resolveSpecifier(
  specifier: string,
  fromFileAbs: string,
  root: string,
  workspace: ReadonlyMap<string, string>,
): string | undefined {
  if (isPathSpecifier(specifier)) {
    const base = pathBase(specifier, fromFileAbs);
    const directoryOnly = specifier === "." || specifier === ".." || specifier.endsWith("/");
    return base === undefined ? undefined : firstExistingFile(pathCandidates(base, directoryOnly));
  }
  const workspaceEntry = workspace.get(specifier);
  if (workspaceEntry !== undefined) {
    return firstExistingFile([workspaceEntry]);
  }
  // Sub-path workspace import, e.g. `@scope/pkg/sub`.
  for (const [name, entry] of workspace) {
    if (specifier.startsWith(`${name}/`)) {
      return firstExistingFile(subPathCandidates(entry, specifier.slice(name.length + 1), root));
    }
  }
  return undefined; // external — checked by the purity walk, not traversed
}

/**
 * Where `<pkg>/<sub>` could live, in the order a package most plausibly means it.
 *
 * The **entry's own directory first**, because `exports["."]` of `./src/index.ts`
 * declares `src/` as that package's source root, and a package laid out that way
 * keeps `sub` beside its entry rather than above it. The package directory second,
 * for a package whose entry sits at its root.
 *
 * Both roots are derived, not assumed. The previous form was
 * `dirname(dirname(entry))`, which hard-codes "the entry is exactly two levels
 * deep": for `<pkg>/src/index.ts` it yielded `<pkg>` and looked for `<pkg>/sub.ts`
 * — never `<pkg>/src/sub.ts`, which is where every package in this repository's
 * host keeps its source — and for an entry at `<pkg>/index.ts` it resolved
 * sub-paths against the package's **parent** (DEBT D-3).
 */
function subPathCandidates(entry: string, sub: string, root: string): string[] {
  const entryDir = dirname(entry);
  const pkgDir = packageDirOf(entry, root);
  const roots = pkgDir === undefined || pkgDir === entryDir ? [entryDir] : [entryDir, pkgDir];
  return roots.flatMap((dir) => pathCandidates(resolve(dir, sub), sub.endsWith("/")));
}

/**
 * The nearest ancestor of `entry` that holds a `package.json`, searching no further
 * up than `root` — the engine reads the repo's own source and nothing above it.
 */
function packageDirOf(entry: string, root: string): string | undefined {
  let dir = dirname(entry);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || !dir.startsWith(root)) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Does `specifier` name a workspace package, exactly or as a sub-path?
 *
 * Deliberately separate from resolving it, because a specifier can be **known
 * internal and still resolve to nothing**, and the two facts have opposite
 * consequences. An external specifier is checked by the purity rule and not
 * traversed, which is correct. A known-internal one that does not resolve means the
 * closure ended early — and {@link resolveSpecifier} returns `undefined` for both,
 * so without this distinction the walk reports the same green either way.
 */
export function isWorkspaceSpecifier(
  specifier: string,
  workspace: ReadonlyMap<string, string>,
): boolean {
  if (workspace.has(specifier)) {
    return true;
  }
  for (const name of workspace.keys()) {
    if (specifier.startsWith(`${name}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Why a module load inside a closure was not followed although it is not a
 * third-party module:
 *
 * - `path` — a path specifier that resolves to no file;
 * - `workspace` — names a workspace package but resolves to no file;
 * - `subpath-import` — a package `imports` alias (`#x`), which this engine does not
 *   resolve;
 * - `computed` — the specifier is an expression, so no static walk can know the file;
 * - `url` — the code lives at a URL (`data:`, `http:`), not in the repository.
 */
export type UnfollowedReason = "path" | "workspace" | "subpath-import" | "computed" | "url";

/** A module load the closure walk could not follow, located. */
export interface UnfollowedImport {
  /** Repo-relative POSIX path of the importing file. */
  readonly file: string;
  /** 1-based line of the load. */
  readonly line: number;
  /** The specifier as written — source text when it is computed. */
  readonly specifier: string;
  readonly reason: UnfollowedReason;
}

/** Why `ref` was not followed, or undefined when it was — or is a third-party module. */
function unfollowedReason(
  ref: ModuleReference,
  fromFileAbs: string,
  root: string,
  workspace: ReadonlyMap<string, string>,
): UnfollowedReason | undefined {
  const { specifier } = ref;
  if (specifier === undefined) {
    return "computed";
  }
  if (isUrlSpecifier(specifier)) {
    return "url";
  }
  if (specifier.startsWith("#")) {
    return "subpath-import";
  }
  const isPath = isPathSpecifier(specifier);
  if (!isPath && !isWorkspaceSpecifier(specifier, workspace)) {
    return undefined; // external — checked by the purity rule, not traversed
  }
  if (resolveSpecifier(specifier, fromFileAbs, root, workspace) !== undefined) {
    return undefined;
  }
  return isPath ? "path" : "workspace";
}

/**
 * Value loads inside `files` that the walk could not follow, although none of them
 * is a third-party module — the evidence that a closure stopped short of where it
 * claimed to reach.
 *
 * Reported rather than traversed-around, following the engine's own idiom: an
 * unresolvable entry point is already never a pass (decision #132), and an
 * unfollowable *edge* is the same defect one step further in. Only an external
 * specifier is silently not traversed, because that is the purity rule's job.
 */
export function unfollowedImports(
  root: string,
  files: readonly string[],
  workspace: ReadonlyMap<string, string>,
): UnfollowedImport[] {
  const out: UnfollowedImport[] = [];
  for (const file of files) {
    const abs = resolve(root, file);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      continue;
    }
    const sf = parseSourceFile(abs);
    for (const ref of moduleReferences(sf)) {
      const reason = unfollowedReason(ref, abs, root, workspace);
      if (reason !== undefined) {
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(ref.position).line + 1,
          specifier: ref.written,
          reason,
        });
      }
    }
  }
  return out;
}

/** An import the walk knows is internal but could not resolve to a file. */
export interface UnresolvedInternalImport {
  /** Repo-relative POSIX path of the importing file. */
  readonly file: string;
  /** 1-based line of the import. */
  readonly line: number;
  readonly specifier: string;
}

/**
 * @deprecated since 0.4.0 — use {@link unfollowedImports}, which reports every load
 * the walk could not follow; this keeps only its `workspace` subset, the question the
 * 0.3.0 export answered.
 */
export function unresolvedWorkspaceImports(
  root: string,
  files: readonly string[],
  workspace: ReadonlyMap<string, string>,
): UnresolvedInternalImport[] {
  return unfollowedImports(root, files, workspace)
    .filter((entry) => entry.reason === "workspace")
    .map(({ file, line, specifier }) => ({ file, line, specifier }));
}

/**
 * Transitive closure of within-repo files reachable from `entryPoints` (repo-
 * relative) by value edges. Missing entry points are skipped (the runner surfaces
 * them); the returned list is repo-relative POSIX, in first-seen order.
 */
export function importClosure(
  root: string,
  entryPoints: readonly string[],
  workspace: ReadonlyMap<string, string>,
): string[] {
  return closureOver(
    entryPoints.map((entry) => toRepoRelative(root, resolveEntry(root, entry))),
    fileSystemEdges(root, workspace),
  );
}

/** Resolve an entry point against the repo root, leaving an absolute one alone. */
function resolveEntry(root: string, entry: string): string {
  return isAbsolute(entry) ? entry : resolve(root, entry);
}

/**
 * The edges out of one node, or `undefined` when the node is not a file at all.
 *
 * The distinction is the traversal's, not the caller's convenience: a node that
 * does not exist is skipped *without being recorded*, because a closure must not
 * claim to have examined a file it never opened (decision #132 made the same point
 * about entry points). A file that exists and imports nothing returns `[]`.
 */
export type EdgeReader = (node: string) => readonly string[] | undefined;

/**
 * Transitive closure of `entryPoints` under `edgesOf`, in first-seen order.
 *
 * This is the whole traversal, and it is deliberately separate from the reading.
 * Before the split, the walker's only input was a filesystem, so verifying it meant
 * materialising a repo per graph — measured at 1.75 ms each, which puts an
 * exhaustive sweep of all directed graphs on five nodes at roughly 17 hours and made
 * the walker effectively untestable. Driven through an injected reader, the same
 * sweep is arithmetic.
 *
 * Node identity is whatever the reader uses, so the traversal is agnostic to paths;
 * {@link importClosure} supplies repo-relative POSIX ones, preserving the dedup key
 * it has always used.
 */
export function closureOver(entryPoints: readonly string[], edgesOf: EdgeReader): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [...entryPoints];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    if (visited.has(node)) {
      continue;
    }
    const edges = edgesOf(node);
    if (edges === undefined) {
      continue;
    }
    visited.add(node);
    order.push(node);
    queue.push(...edges);
  }
  return order;
}

/**
 * An {@link EdgeReader} backed by the repo on disk: parse the file, keep the value
 * imports, resolve each back to a repo-relative path, and drop the external ones —
 * those are checked by the purity rule rather than traversed.
 */
function fileSystemEdges(root: string, workspace: ReadonlyMap<string, string>): EdgeReader {
  return (node: string) => {
    const abs = resolveEntry(root, node);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return undefined;
    }
    const edges: string[] = [];
    for (const specifier of valueSpecifiers(parseSourceFile(abs))) {
      const resolved = resolveSpecifier(specifier, abs, root, workspace);
      if (resolved !== undefined) {
        edges.push(toRepoRelative(root, resolved));
      }
    }
    return edges;
  };
}
