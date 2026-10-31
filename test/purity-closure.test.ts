import { describe, expect, test } from "bun:test";
import { runPurityClosure } from "../src/checks/purity-closure";
import { FORBIDDEN_NONDETERMINISM, PURE_SURFACE } from "../src/tokens";
import type { AllowedSurface, CheckResult, ForbiddenTokens, PurityClosureRule } from "../src/types";
import { tree } from "./tree";

/**
 * The purity check against what it claims, spelled every way a closure can reach the
 * clock, entropy, I/O or a code evaluator.
 *
 * Its origin is an external review, which is the point of keeping it: the review
 * listed three spellings the denylist did not see, and a probe built from them found
 * twenty-two, plus four import forms the closure walk dropped without a finding. The
 * ground truth here is the language — each fixture below demonstrably reaches the
 * host when it runs — not anything this engine says about itself.
 */

const NOTHING_FORBIDDEN: ForbiddenTokens = {
  imports: [],
  propertyAccess: [],
  newExpressions: [],
  callExpressions: [],
};

/** Run one rule over a one-file closure `src/entry.ts`, plus any extra files. */
function check(
  entry: string,
  rule: Partial<PurityClosureRule>,
  extra: Readonly<Record<string, string>> = {},
): CheckResult {
  const { root, cleanup } = tree({ "src/entry.ts": entry, ...extra });
  try {
    return runPurityClosure(root, {
      id: "pure",
      entryPoints: ["src/entry.ts"],
      forbidden: NOTHING_FORBIDDEN,
      ...rule,
    });
  } finally {
    cleanup();
  }
}

/**
 * Each of these reaches the host. The first nine are the clock and entropy in other
 * spellings; then I/O through other module names and load forms; then code
 * evaluation; then the forms the binder has to get right (a class heritage, a
 * shorthand property, a `typeof` probe, a `declare`d global, module metadata).
 */
const REACHES_THE_HOST: Readonly<Record<string, string>> = {
  "a member through globalThis": "export const f = () => globalThis.Date.now();\n",
  "an element access": 'export const f = () => Date["now"]();\n',
  "an alias": "const D = Date;\nexport const f = () => D.now();\n",
  "a destructured member": "const { random } = Math;\nexport const f = () => random();\n",
  "construction through globalThis": "export const f = () => new globalThis.Date();\n",
  "entropy through globalThis": "export const f = () => globalThis.crypto.randomUUID();\n",
  "Reflect.get": 'export const f = () => (Reflect.get(Date, "now") as () => number)();\n',
  "a computed key": 'const k = "no" + "w";\nexport const f = () => (Date as never)[k];\n',
  "an aliased perf_hooks import":
    'import { performance as p } from "node:perf_hooks";\nexport const f = () => p.now();\n',
  "the environment": 'export const f = () => process.env["MODE"];\n',
  "bare fs/promises":
    'import { readFile } from "fs/promises";\nexport const f = () => readFile("x");\n',
  child_process:
    'import { execSync } from "node:child_process";\nexport const f = () => execSync("true");\n',
  "a namespace import of bare crypto":
    'import * as c from "crypto";\nexport const f = () => c.randomUUID();\n',
  require: 'const fs = require("node:fs");\nexport const f = () => fs.readFileSync("x");\n',
  "import-equals":
    'import fs = require("node:fs");\nexport const f = () => fs.readFileSync("x");\n',
  "a template dynamic import": "export const f = () => import(`node:fs`);\n",
  "the Bun global": 'export const f = () => Bun.spawn(["true"]);\n',
  "the bun module": 'import { spawn } from "bun";\nexport const f = () => spawn(["true"]);\n',
  eval: "export const f = (src: string) => eval(src);\n",
  "new Function": "export const f = (src: string) => new Function(src)();\n",
  "fetch through globalThis": 'export const f = () => globalThis.fetch("https://x.invalid");\n',
  "bare net": 'import net from "net";\nexport const f = () => net.connect(1);\n',
  "a class extending Date": "class Clock extends Date {}\nexport const f = () => Clock.now();\n",
  "a shorthand property": "export const f = () => ({ fetch });\n",
  "a typeof probe": 'export const f = () => typeof process !== "undefined";\n',
  "a declared global":
    'declare const Bun: { spawn(cmd: string[]): void };\nexport const f = () => Bun.spawn(["true"]);\n',
  "module metadata": "export const f = () => import.meta.url;\n",
};

describe("allowlist mode — every spelling that reaches the host is a finding", () => {
  for (const [spelling, source] of Object.entries(REACHES_THE_HOST)) {
    test(spelling, () => {
      const result = check(source, { allowed: PURE_SURFACE });
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings.every((finding) => finding.checkId === "pure")).toBe(true);
    });
  }
});

describe("allowlist mode — what it must leave alone", () => {
  /**
   * The healthy control. Without it every arm above would pass against a check that
   * reports every identifier in the file.
   */
  const HEALTHY = [
    'import { z } from "zod";',
    "const fetch = (url: string): string => url;",
    "export class Ledger {",
    "  readonly entries = new Map<string, number>();",
    "  add(key: string, value: number): void {",
    "    this.entries.set(key, Math.max(value, 0));",
    "  }",
    "}",
    "export type Stamped = { readonly at: Date };",
    "export const decide = (xs: readonly number[]) => {",
    "  const { length } = xs;",
    "  const total = xs.reduce((a, b) => a + b, 0);",
    "  outer: for (const x of xs) {",
    "    if (x < 0) break outer;",
    "  }",
    "  return {",
    "    mean: Math.round(total / Math.max(length, 1)),",
    "    epoch: Date.UTC(2020, 0, 1),",
    "    copy: JSON.parse(JSON.stringify({ total })) as unknown,",
    "    finite: Number.isFinite(total),",
    "    keys: Object.keys({ total }),",
    "    schema: z.string(),",
    '    local: fetch("not the global"),',
    '    error: new Error("x"),',
    "  };",
    "};",
  ].join("\n");

  test("pure code, a shadowing local, types and allowed members produce nothing", () => {
    const result = check(HEALTHY, { allowed: { ...PURE_SURFACE, externalImports: ["zod"] } });
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  test("the same code without zod on the list is refused exactly once, at the import", () => {
    const result = check(HEALTHY, { allowed: PURE_SURFACE });
    expect(result.findings.map((finding) => finding.token)).toEqual(["zod"]);
    expect(result.findings[0]?.line).toBe(1);
  });

  test("a member outside the allowed set is named, with the member", () => {
    const result = check("export const f = () => Math.random();\n", { allowed: PURE_SURFACE });
    expect(result.findings.map((finding) => finding.token)).toEqual(["Math.random"]);
  });

  test("an allowed member read by a string key is still the allowed member", () => {
    const result = check('export const f = () => Math["min"](1, 2);\n', { allowed: PURE_SURFACE });
    expect(result.findings).toEqual([]);
  });

  test("JSX is refused: its runtime import appears nowhere in the source", () => {
    const { root, cleanup } = tree({ "src/entry.tsx": "export const v = <b>x</b>;\n" });
    try {
      const result = runPurityClosure(root, {
        id: "pure",
        entryPoints: ["src/entry.tsx"],
        forbidden: NOTHING_FORBIDDEN,
        allowed: PURE_SURFACE,
      });
      expect(result.findings.map((finding) => finding.token)).toEqual(["JSX"]);
    } finally {
      cleanup();
    }
  });
});

describe("allowlist mode — the escape hatch is bounded", () => {
  const widened = (surface: Partial<AllowedSurface>): AllowedSurface => ({
    ...PURE_SURFACE,
    ...surface,
  });

  test("granting globalThis or eval is refused, whatever the code does", () => {
    for (const key of ["globalThis", "eval", "Function", "window", "self", "global"]) {
      const result = check("export const x = 1;\n", {
        allowed: widened({ globals: [...PURE_SURFACE.globals, key] }),
      });
      expect(result.findings.map((finding) => finding.token)).toEqual([key]);
      expect(result.findings[0]?.message).toContain("refused");
    }
  });

  test("a skeleton key is refused as a member-restricted entry too", () => {
    const result = check("export const x = 1;\n", {
      allowed: widened({ globalMembers: { ...PURE_SURFACE.globalMembers, globalThis: ["Date"] } }),
    });
    expect(result.findings.map((finding) => finding.token)).toEqual(["globalThis"]);
  });

  test("a name allowed both freely and member-restricted is refused", () => {
    const result = check("export const x = 1;\n", {
      allowed: widened({ globals: [...PURE_SURFACE.globals, "Math"] }),
    });
    expect(result.findings.map((finding) => finding.token)).toEqual(["Math"]);
    expect(result.findings[0]?.message).toContain("voids");
  });

  test("a global name that is also an Object.prototype key is looked up, not inherited", () => {
    // `globalMembers` is a plain object: a lookup of "toString" through it would find
    // Object.prototype.toString and treat a function as a member list.
    const result = check("export const f = () => toString();\n", { allowed: PURE_SURFACE });
    expect(result.findings.map((finding) => finding.token)).toEqual(["toString"]);
  });
});

describe("denylist mode — every load form, and only value loads", () => {
  const NO_FS: ForbiddenTokens = { ...NOTHING_FORBIDDEN, imports: ["node:fs"] };

  test("each load form of a forbidden module is a finding", () => {
    for (const source of [
      'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n',
      'export { readFileSync } from "node:fs";\n',
      'import fs = require("node:fs");\nexport const x = fs;\n',
      'export const x = require("node:fs");\n',
      'export const x = import("node:fs");\n',
      "export const x = import(`node:fs`);\n",
      'export const x = import.meta.require("node:fs");\n',
    ]) {
      expect(check(source, { forbidden: NO_FS }).findings.map((f) => f.token)).toEqual(["node:fs"]);
    }
  });

  test("a type-only import of a forbidden module is erased, so it is not a finding", () => {
    const source = 'import type { Stats } from "node:fs";\nexport type S = Stats;\n';
    expect(check(source, { forbidden: NO_FS }).findings).toEqual([]);
  });

  test("the denylist matches spellings: the review's first example passes it", () => {
    // Recorded, not endorsed — this is why allowlist mode exists. If the denylist ever
    // learns this spelling, this arm should flip and the README with it.
    const source = "export const f = () => globalThis.Date.now();\n";
    expect(check(source, { forbidden: FORBIDDEN_NONDETERMINISM }).findings).toEqual([]);
  });
});

describe("a closure never ends in silence", () => {
  test("a relative import that resolves to nothing is a finding of the rule", () => {
    const result = check('import "./gone";\n', { forbidden: FORBIDDEN_NONDETERMINISM });
    expect(result.findings.map((finding) => finding.token)).toEqual(["./gone"]);
    expect(result.findings[0]?.message).toContain("never a pass");
  });

  test("the nodenext edge is followed into the file it means, and its clock is found", () => {
    const result = check(
      'import "./helper.js";\n',
      { forbidden: FORBIDDEN_NONDETERMINISM },
      { "src/helper.ts": "export const t = Date.now();\n" },
    );
    expect(result.filesScanned).toBe(2);
    expect(result.findings.map((finding) => `${finding.file} ${finding.token}`)).toEqual([
      "src/helper.ts Date.now",
    ]);
  });

  test("a computed load is a finding unless the rule declares it — then it is counted", () => {
    const loader = "export const load = (p: string) => import(p);\n";
    const undeclared = check(loader, { forbidden: FORBIDDEN_NONDETERMINISM });
    expect(undeclared.findings.map((finding) => finding.token)).toEqual(["p"]);

    const declared = check(loader, {
      forbidden: FORBIDDEN_NONDETERMINISM,
      computedLoadsAllowedIn: ["src/entry.ts"],
    });
    expect(declared.findings).toEqual([]);
    expect(declared.skipped).toEqual([
      { reason: "declared computed load, not followed", count: 1 },
    ]);
  });

  test("a declared computed load that is not there is a stale exception, and a finding", () => {
    const result = check("export const x = 1;\n", {
      forbidden: FORBIDDEN_NONDETERMINISM,
      computedLoadsAllowedIn: ["src/entry.ts"],
    });
    expect(result.findings.map((finding) => finding.token)).toEqual(["computedLoadsAllowedIn"]);
  });

  test("a declaration covers computed loads only — a missing path stays a finding", () => {
    const result = check('import "./gone";\n', {
      forbidden: FORBIDDEN_NONDETERMINISM,
      computedLoadsAllowedIn: ["src/entry.ts"],
    });
    expect(result.findings.map((finding) => finding.token).sort()).toEqual([
      "./gone",
      "computedLoadsAllowedIn",
    ]);
  });
});
