import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  importClosure,
  isExternalSpecifier,
  isPathSpecifier,
  moduleReferences,
  parseSourceFile,
  resolveSpecifier,
  unfollowedImports,
  unresolvedWorkspaceImports,
} from "../src/graph";
import { run } from "../src/runner";
import { tree } from "./tree";

/**
 * The reading half, now that {@link closureOver} owns the traversal.
 *
 * Splitting the walker left two pieces with different risks. The traversal is
 * checked by laws over a complete input space (`closure-laws.test.ts`). The reader
 * is checked here, against a real tree on disk, because its whole job is to agree
 * with a filesystem and no law can say what a filesystem contains.
 *
 * These were the untested half: resolution picks between four candidate paths per
 * relative specifier and walks a package map for bare ones, and getting it wrong
 * does not fail loudly — it silently shrinks a closure, which is exactly the
 * blindness the vacuity and empty-scan refusals exist to catch one level up.
 */

describe("resolveSpecifier — which file a specifier means", () => {
  test("a relative specifier prefers the .ts sibling over a directory index", () => {
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "src/dep.ts": "",
      "src/dep/index.ts": "",
    });
    try {
      const got = resolveSpecifier("./dep", join(root, "src/a.ts"), root, new Map());
      expect(got).toBe(join(root, "src/dep.ts"));
    } finally {
      cleanup();
    }
  });

  test("a relative specifier falls back to a directory index", () => {
    const { root, cleanup } = tree({ "src/a.ts": "", "src/dep/index.ts": "" });
    try {
      const got = resolveSpecifier("./dep", join(root, "src/a.ts"), root, new Map());
      expect(got).toBe(join(root, "src/dep/index.ts"));
    } finally {
      cleanup();
    }
  });

  test("a relative specifier that resolves to nothing is undefined, not a guess", () => {
    const { root, cleanup } = tree({ "src/a.ts": "" });
    try {
      expect(resolveSpecifier("./gone", join(root, "src/a.ts"), root, new Map())).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a bare specifier outside the package map stays external", () => {
    const { root, cleanup } = tree({ "src/a.ts": "" });
    try {
      // External specifiers are checked by the purity rule, never traversed —
      // following them would pull node_modules into the closure.
      expect(resolveSpecifier("zod", join(root, "src/a.ts"), root, new Map())).toBeUndefined();
      expect(resolveSpecifier("node:fs", join(root, "src/a.ts"), root, new Map())).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("a mapped package specifier resolves to its declared entry", () => {
    const { root, cleanup } = tree({ "src/a.ts": "", "pkg/src/index.ts": "" });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      const got = resolveSpecifier("@scope/pkg", join(root, "src/a.ts"), root, workspace);
      expect(got).toBe(join(root, "pkg/src/index.ts"));
    } finally {
      cleanup();
    }
  });

  /**
   * These four were characterisation tests pinning the defect in DEBT D-3; #194
   * flipped them to the behaviour the engine should have had. The old shape
   * resolved `<pkg>/<sub>` against `dirname(dirname(entry))`, which both missed a
   * `src/` layout and assumed the entry sits exactly two levels deep.
   */
  test("a sub-path resolves against the package's source root, beside its entry", () => {
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
      "pkg/src/deep.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      const got = resolveSpecifier("@scope/pkg/deep", join(root, "src/a.ts"), root, workspace);
      expect(got).toBe(join(root, "pkg/src/deep.ts"));
    } finally {
      cleanup();
    }
  });

  test("the source root wins over the package root when a file sits in both", () => {
    // `exports["."]` of `./src/index.ts` declares src/ as the source root, so that
    // is the more specific answer; the package root stays a fallback.
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
      "pkg/src/deep.ts": "",
      "pkg/deep.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      expect(resolveSpecifier("@scope/pkg/deep", join(root, "src/a.ts"), root, workspace)).toBe(
        join(root, "pkg/src/deep.ts"),
      );
    } finally {
      cleanup();
    }
  });

  test("a sub-path still resolves at the package root when the entry sits there", () => {
    // The depth assumption the old derivation made: an entry at `<pkg>/index.ts`
    // used to resolve sub-paths against the package's PARENT.
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/index.ts": "",
      "pkg/deep.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/index.ts")]]);
      expect(resolveSpecifier("@scope/pkg/deep", join(root, "src/a.ts"), root, workspace)).toBe(
        join(root, "pkg/deep.ts"),
      );
    } finally {
      cleanup();
    }
  });

  test("a sub-path that resolves nowhere is still undefined, not a guess", () => {
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      expect(
        resolveSpecifier("@scope/pkg/gone", join(root, "src/a.ts"), root, workspace),
      ).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("importClosure — the reader and the traversal together", () => {
  test("a value import is followed, a type-only import is not", () => {
    // `import type` is erased at build, so it carries no runtime impurity into the
    // closure. Following it would make the purity closure over-approximate.
    const { root, cleanup } = tree({
      "src/a.ts":
        'import { v } from "./value";\nimport type { T } from "./typeonly";\nexport const x = v;\n',
      "src/value.ts": "export const v = 1;\n",
      "src/typeonly.ts": "export type T = string;\n",
    });
    try {
      const got = importClosure(root, ["src/a.ts"], new Map());
      expect(got).toContain("src/value.ts");
      expect(got).not.toContain("src/typeonly.ts");
    } finally {
      cleanup();
    }
  });

  test("a cycle on disk terminates and records each file once", () => {
    const { root, cleanup } = tree({
      "src/a.ts": 'import { b } from "./b";\nexport const a = b;\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    });
    try {
      const got = importClosure(root, ["src/a.ts"], new Map());
      expect(got.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      cleanup();
    }
  });

  test("an entry point that is a directory is skipped, not recorded", () => {
    const { root, cleanup } = tree({ "src/a.ts": "" });
    try {
      expect(importClosure(root, ["src"], new Map())).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("an absolute entry point is accepted and reported repo-relative", () => {
    const { root, cleanup } = tree({ "src/a.ts": "export const a = 1;\n" });
    try {
      expect(importClosure(root, [join(root, "src/a.ts")], new Map())).toEqual(["src/a.ts"]);
    } finally {
      cleanup();
    }
  });
});

describe("unresolvedWorkspaceImports — a closure may not end quietly", () => {
  test("a workspace sub-path that resolves to nothing is reported, with its line", () => {
    const { root, cleanup } = tree({
      "src/a.ts": '\n\nimport { x } from "@scope/pkg/gone";\nexport const a = x;\n',
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "export const i = 1;\n",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      const got = unresolvedWorkspaceImports(root, ["src/a.ts"], workspace);
      expect(got).toHaveLength(1);
      expect(got[0]?.specifier).toBe("@scope/pkg/gone");
      expect(got[0]?.file).toBe("src/a.ts");
      // Locatable, not just "line 1" — a finding nobody can find is a rumour.
      expect(got[0]?.line).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("an external specifier is NOT reported — that is the whole distinction", () => {
    // resolveSpecifier returns undefined for both cases. Reporting them alike would
    // turn every third-party import into a finding.
    const { root, cleanup } = tree({
      "src/a.ts": 'import { z } from "zod";\nimport { readFileSync } from "node:fs";\n',
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      expect(unresolvedWorkspaceImports(root, ["src/a.ts"], workspace)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a workspace import that DOES resolve is not reported", () => {
    const { root, cleanup } = tree({
      "src/a.ts": 'import { d } from "@scope/pkg/deep";\n',
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
      "pkg/src/deep.ts": "export const d = 1;\n",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      expect(unresolvedWorkspaceImports(root, ["src/a.ts"], workspace)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a type-only import of a missing workspace path is not reported", () => {
    // Type edges are erased at build and are not traversed, so they cannot shorten
    // a closure and must not produce a finding either.
    const { root, cleanup } = tree({
      "src/a.ts": 'import type { T } from "@scope/pkg/gone";\nexport type U = T;\n',
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
      "pkg/src/index.ts": "",
    });
    try {
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      expect(unresolvedWorkspaceImports(root, ["src/a.ts"], workspace)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("the exact package name, unresolvable, is reported too", () => {
    const { root, cleanup } = tree({
      "src/a.ts": 'import { i } from "@scope/pkg";\n',
      "pkg/package.json": '{ "name": "@scope/pkg" }\n',
    });
    try {
      // The map points at an entry file that is not there — a package mid-rename.
      const workspace = new Map([["@scope/pkg", join(root, "pkg/src/index.ts")]]);
      const got = unresolvedWorkspaceImports(root, ["src/a.ts"], workspace);
      expect(got).toHaveLength(1);
      expect(got[0]?.specifier).toBe("@scope/pkg");
    } finally {
      cleanup();
    }
  });
});

describe("runPurityClosure — the reporting is wired, not just available", () => {
  test("an unresolvable workspace import becomes a finding of that rule", () => {
    // End to end through run(), because "the wiring is only eight lines" is the
    // assumption that has already produced two tests passing off a different
    // guard in this repository. The helper working is not the claim; the gate
    // reporting is.
    const { root, cleanup } = tree({
      "packages/foo/package.json": '{ "name": "@x/foo", "exports": { ".": "./src/index.ts" } }\n',
      "packages/foo/src/index.ts": "export const i = 1;\n",
      "src/entry.ts": 'import { g } from "@x/foo/gone";\nexport const e = g;\n',
    });
    try {
      const result = run(
        {
          purityClosures: [
            {
              id: "wired",
              entryPoints: ["src/entry.ts"],
              forbidden: {
                imports: ["node:fs"],
                propertyAccess: [],
                newExpressions: [],
                callExpressions: [],
              },
            },
          ],
        },
        root,
      );
      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.token === "@x/foo/gone");
      expect(finding).toBeDefined();
      expect(finding?.checkId).toBe("wired");
      expect(finding?.file).toBe("src/entry.ts");
      expect(finding?.line).toBe(1);
      expect(finding?.message).toContain("never a pass");
    } finally {
      cleanup();
    }
  });

  test("the same tree with a resolvable sub-path is clean", () => {
    // The control. Without it, the arm above would pass against an engine that
    // refuses every workspace import.
    const { root, cleanup } = tree({
      "packages/foo/package.json": '{ "name": "@x/foo", "exports": { ".": "./src/index.ts" } }\n',
      "packages/foo/src/index.ts": "export const i = 1;\n",
      "packages/foo/src/here.ts": "export const g = 2;\n",
      "src/entry.ts": 'import { g } from "@x/foo/here";\nexport const e = g;\n',
    });
    try {
      const result = run(
        {
          purityClosures: [
            {
              id: "wired",
              entryPoints: ["src/entry.ts"],
              forbidden: {
                imports: ["node:fs"],
                propertyAccess: [],
                newExpressions: [],
                callExpressions: [],
              },
            },
          ],
        },
        root,
      );
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      // And the closure actually crossed the package boundary, which is the
      // behaviour #194 restored.
      expect(result.results[0]?.filesScanned).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("resolveSpecifier — the forms a closure used to lose (0.4.0)", () => {
  test("`./x.js` means the TypeScript source beside it, as under nodenext", () => {
    // Before 0.4.0 this resolved to nothing and the walk dropped the edge in silence:
    // every relative import of a nodenext project ended its closure.
    const { root, cleanup } = tree({ "src/a.ts": "", "src/dep.ts": "" });
    try {
      const got = resolveSpecifier("./dep.js", join(root, "src/a.ts"), root, new Map());
      expect(got).toBe(join(root, "src/dep.ts"));
    } finally {
      cleanup();
    }
  });

  test("an explicit extension names that file when it exists — what a runtime loads", () => {
    const { root, cleanup } = tree({ "src/a.ts": "", "src/dep.js": "", "src/dep.ts": "" });
    try {
      const got = resolveSpecifier("./dep.js", join(root, "src/a.ts"), root, new Map());
      expect(got).toBe(join(root, "src/dep.js"));
    } finally {
      cleanup();
    }
  });

  test("`.mjs` maps to `.mts`, and an extensionless specifier finds `.mjs` and `index.tsx`", () => {
    const { root, cleanup } = tree({
      "src/a.ts": "",
      "src/m.mts": "",
      "src/plain.mjs": "",
      "src/comp/index.tsx": "",
    });
    try {
      const from = join(root, "src/a.ts");
      expect(resolveSpecifier("./m.mjs", from, root, new Map())).toBe(join(root, "src/m.mts"));
      expect(resolveSpecifier("./plain", from, root, new Map())).toBe(join(root, "src/plain.mjs"));
      expect(resolveSpecifier("./comp", from, root, new Map())).toBe(
        join(root, "src/comp/index.tsx"),
      );
    } finally {
      cleanup();
    }
  });

  test("`.` means the directory's index, never a sibling file named after the directory", () => {
    const { root, cleanup } = tree({ "src/a.ts": "", "src/index.ts": "", "src.ts": "" });
    try {
      expect(resolveSpecifier(".", join(root, "src/a.ts"), root, new Map())).toBe(
        join(root, "src/index.ts"),
      );
    } finally {
      cleanup();
    }
  });

  test("a `file:` URL is a path, resolved like one", () => {
    const { root, cleanup } = tree({ "src/a.ts": "", "src/dep.ts": "" });
    try {
      const url = pathToFileURL(join(root, "src/dep.ts")).href;
      expect(resolveSpecifier(url, join(root, "src/a.ts"), root, new Map())).toBe(
        join(root, "src/dep.ts"),
      );
    } finally {
      cleanup();
    }
  });
});

describe("specifier classification", () => {
  test("a first segment of `.` or `..` makes a path; a leading dot alone does not", () => {
    for (const path of [".", "..", "./x", "../x", "./", "file:///x.ts"]) {
      expect(isPathSpecifier(path)).toBe(true);
    }
    for (const bare of [".x", "zod", "node:fs", "@scope/pkg", "#internal"]) {
      expect(isPathSpecifier(bare)).toBe(false);
    }
  });

  test("only third-party and runtime modules are external", () => {
    const workspace = new Map([["@scope/pkg", "/repo/pkg/src/index.ts"]]);
    expect(isExternalSpecifier("zod", workspace)).toBe(true);
    expect(isExternalSpecifier("node:fs", workspace)).toBe(true);
    for (const internal of [
      "./x",
      "#internal",
      "@scope/pkg",
      "@scope/pkg/sub",
      "data:text/javascript,1",
    ]) {
      expect(isExternalSpecifier(internal, workspace)).toBe(false);
    }
  });
});

describe("moduleReferences — every run-time load is an edge", () => {
  test("each load form is seen, with the literal it names", () => {
    const { root, cleanup } = tree({
      "src/a.ts": [
        'import { a } from "./a1";',
        'export { b } from "./a2";',
        'import c = require("./a3");',
        'const d = require("./a4");',
        'const e = import("./a5");',
        "const f = import(`./a6`);",
        'const g = import.meta.require("./a7");',
        "export const all = [a, c, d, e, f, g];",
      ].join("\n"),
    });
    try {
      const refs = moduleReferences(parseSourceFile(join(root, "src/a.ts")));
      expect(refs.map((ref) => ref.specifier)).toEqual([
        "./a1",
        "./a2",
        "./a3",
        "./a4",
        "./a5",
        "./a6",
        "./a7",
      ]);
    } finally {
      cleanup();
    }
  });

  test("type-only forms are not loads", () => {
    const { root, cleanup } = tree({
      "src/a.ts": [
        'import type { T } from "./t1";',
        'export type { U } from "./t2";',
        'import type V = require("./t3");',
        "export type W = T | U | V;",
      ].join("\n"),
    });
    try {
      expect(moduleReferences(parseSourceFile(join(root, "src/a.ts")))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a computed specifier is recorded as such, with its source text", () => {
    const { root, cleanup } = tree({
      "src/a.ts": "export const load = (name: string) => import(`./${name}`);\n",
    });
    try {
      const [ref] = moduleReferences(parseSourceFile(join(root, "src/a.ts")));
      expect(ref?.specifier).toBeUndefined();
      expect(ref?.written).toBe("`./${name}`");
    } finally {
      cleanup();
    }
  });
});

describe("importClosure — follows every load form", () => {
  test("require, import-equals, template import and a nodenext `.js` specifier are all edges", () => {
    // The four edges the probe of 2026-10-31 showed dropped without a word.
    const { root, cleanup } = tree({
      "src/entry.ts": [
        'import "./viaJs.js";',
        'import r = require("./viaImportEquals");',
        'const q = require("./viaRequire");',
        "const t = import(`./viaTemplate`);",
        "export const all = [r, q, t];",
      ].join("\n"),
      "src/viaJs.ts": "",
      "src/viaImportEquals.ts": "",
      "src/viaRequire.ts": "",
      "src/viaTemplate.ts": "",
    });
    try {
      expect(importClosure(root, ["src/entry.ts"], new Map()).sort()).toEqual([
        "src/entry.ts",
        "src/viaImportEquals.ts",
        "src/viaJs.ts",
        "src/viaRequire.ts",
        "src/viaTemplate.ts",
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("unfollowedImports — every load the walk could not follow, with why", () => {
  test("each unfollowable form is reported once, with its reason and line", () => {
    const { root, cleanup } = tree({
      "src/a.ts": [
        'import "./gone";',
        'import "#internal";',
        "export const c = (n: string) => import(n);",
        'import "data:text/javascript,export default 1";',
        'import "zod";',
        'import "./here";',
      ].join("\n"),
      "src/here.ts": "",
    });
    try {
      const got = unfollowedImports(root, ["src/a.ts"], new Map());
      expect(got.map(({ reason, line, specifier }) => ({ reason, line, specifier }))).toEqual([
        { reason: "path", line: 1, specifier: "./gone" },
        { reason: "subpath-import", line: 2, specifier: "#internal" },
        { reason: "computed", line: 3, specifier: "n" },
        { reason: "url", line: 4, specifier: "data:text/javascript,export default 1" },
      ]);
    } finally {
      cleanup();
    }
  });
});
