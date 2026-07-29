import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Within-repo import-closure over the AST (build brief §4.3 step 2). Follows only
 * VALUE edges (a `import type` is erased at build and carries no runtime impurity),
 * resolves relative and workspace specifiers to repo files, and does NOT follow
 * external (`node:` / npm) specifiers — those are checked, not traversed, by the
 * purity check itself.
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

/** Every module specifier reached by a VALUE edge from this file. */
function valueSpecifiers(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImport(node)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyExport(node)) {
        specs.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteral(arg)) {
        specs.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
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
 * Resolve a module specifier to an absolute repo file, or undefined if it is
 * external (`node:` / npm) or cannot be resolved within the repo.
 */
export function resolveSpecifier(
  specifier: string,
  fromFileAbs: string,
  root: string,
  workspace: ReadonlyMap<string, string>,
): string | undefined {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(fromFileAbs), specifier);
    return firstExistingFile([`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]);
  }
  const workspaceEntry = workspace.get(specifier);
  if (workspaceEntry !== undefined) {
    return firstExistingFile([workspaceEntry]);
  }
  // Sub-path workspace import (e.g. `@scope/pkg/sub`): resolve against the package dir.
  for (const [name, entry] of workspace) {
    if (specifier.startsWith(`${name}/`)) {
      const pkgDir = dirname(dirname(entry)); // .../pkg/src/index.ts → .../pkg
      const sub = specifier.slice(name.length + 1);
      const base = resolve(pkgDir, sub);
      return firstExistingFile([`${base}.ts`, join(base, "index.ts"), base]);
    }
  }
  return undefined; // external — checked by the purity walk, not traversed
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
  const visited = new Set<string>();
  const order: string[] = [];
  const queue: string[] = entryPoints.map((entry) =>
    isAbsolute(entry) ? entry : resolve(root, entry),
  );
  while (queue.length > 0) {
    const abs = queue.shift();
    if (abs === undefined) {
      break;
    }
    const rel = toRepoRelative(root, abs);
    if (visited.has(rel)) {
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      continue;
    }
    visited.add(rel);
    order.push(rel);
    const sf = parseSourceFile(abs);
    for (const specifier of valueSpecifiers(sf)) {
      const resolved = resolveSpecifier(specifier, abs, root, workspace);
      if (resolved !== undefined) {
        queue.push(resolved);
      }
    }
  }
  return order;
}
