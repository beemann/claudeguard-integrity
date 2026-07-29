import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * This package is developed inside a larger private repository and published from
 * it. The README says the move is "this directory alone" — this test is what makes
 * that a fact rather than a hope.
 *
 * It is deliberately written as a test inside the engine, not as a rule in the host
 * project's config: the property must travel WITH the folder, so the published copy
 * keeps proving it after the move, when that config is no longer around.
 *
 * Three things would break a lift, and each is asserted below:
 *  1. **An import that escapes the directory.** Source may only reach its own tree,
 *     node builtins, and declared dependencies.
 *  2. **An undeclared dependency.** Resolvable here only because a sibling package
 *     happens to install it — the classic "works in the monorepo" trap.
 *  3. **A tsconfig that inherits from the repo root**, which vanishes on the move.
 */

const ENGINE_ROOT = resolve(import.meta.dir, "..");
const SRC = join(ENGINE_ROOT, "src");

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  /** Exactly what npm puts in the tarball — the definition of "ships". */
  readonly files?: readonly string[];
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(ENGINE_ROOT, "package.json"), "utf8")) as Manifest;
}

/** Every `.ts` file under `src`, recursively. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Module specifiers of static imports and re-exports. */
function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu)].map(
    (match) => match[1] ?? "",
  );
}

/** Every text file the manifest ships, directories expanded. Excludes `test/`. */
function shippedTextFiles(): string[] {
  const readable = /\.(?:ts|tsx|md|json|ya?ml)$/u;
  return (manifest().files ?? []).flatMap((entry) => {
    const full = join(ENGINE_ROOT, entry);
    if (!existsSync(full)) return [];
    if (statSync(full).isDirectory()) return sourceFiles(full).filter((f) => readable.test(f));
    return readable.test(full) ? [full] : [];
  });
}

/** The npm package a bare specifier belongs to (`a/b/c.js` → `a`, `@s/p/x` → `@s/p`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

describe("lift readiness — the folder must move without edits", () => {
  const declared = new Set([
    ...Object.keys(manifest().dependencies ?? {}),
    ...Object.keys(manifest().devDependencies ?? {}),
  ]);

  test("no source file imports anything outside this directory", () => {
    const escapes: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of specifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (!target.startsWith(SRC)) {
          escapes.push(`${file} → ${specifier}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  test("every bare import is a node builtin or a DECLARED dependency", () => {
    const undeclared: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of specifiers(file)) {
        if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
        const pkg = packageOf(specifier);
        if (!declared.has(pkg)) {
          undeclared.push(`${file} → ${specifier}`);
        }
      }
    }
    // Resolving today only proves a sibling package installed it; the lifted repo
    // installs from THIS manifest and nothing else.
    expect(undeclared).toEqual([]);
  });

  test("the tsconfig does not extend anything outside this directory", () => {
    const tsconfig = readFileSync(join(ENGINE_ROOT, "tsconfig.json"), "utf8");
    expect(tsconfig).not.toContain('"extends"');
  });

  test("the MIT licence ships with the engine (decision #129)", () => {
    expect(readFileSync(join(ENGINE_ROOT, "LICENSE"), "utf8")).toContain("MIT License");
  });

  test("every file the manifest promises to ship actually exists", () => {
    // A manifest listing a file that is not there publishes a package missing its
    // own documentation, and npm says nothing about it.
    const missing = (manifest().files ?? []).filter(
      (entry) => !existsSync(join(ENGINE_ROOT, entry)),
    );
    expect(missing).toEqual([]);
  });

  test("NOTHING THAT SHIPS REACHES OUTSIDE THIS DIRECTORY, prose included", () => {
    // The import test above covers `src`. This covers what the compiler never reads:
    // README, SKILL, CHANGELOG, the example config. A published doc that points at a
    // path from the private repo it was extracted from is an instruction the reader
    // cannot follow — and it is exactly how a host-specific detail escapes review,
    // because no type-checker or AST rule looks at prose.
    const escapes: string[] = [];
    for (const file of shippedTextFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(/\.\.\/[^\s)"'`,;]*/gu)) {
          // Resolve before judging: `../graph` from `src/checks/` stays inside the
          // package and is perfectly fine. Only a path that lands outside the
          // directory is a reference the published copy cannot satisfy.
          const target = resolve(dirname(file), match[0]);
          if (!target.startsWith(ENGINE_ROOT + sep)) {
            escapes.push(`${file}:${String(index + 1)} → ${match[0]}`);
          }
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  test("the shipped SKILL.md is a usable skill, not just a document", () => {
    // Frontmatter with `name` and `description` is what makes it loadable at all;
    // without it the file is prose that no agent will ever read.
    const skill = readFileSync(join(ENGINE_ROOT, "SKILL.md"), "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("\nname: ");
    expect(skill).toContain("\ndescription: ");
  });
});
