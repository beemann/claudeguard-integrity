import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/runner";
import type { ForbiddenTokens, IntegrityConfig } from "../src/types";
import { vacuousRules } from "../src/vacuity";

/**
 * Vacuity is the half of blindness that is decidable from a rule's declaration.
 *
 * These are the engine's own tests, so every config below is synthetic: no host
 * project's rule or parameter appears, because this directory is published exactly
 * as it stands (build brief D4). The mutation suite that blinds a *real* config
 * lives beside that config, on the private side.
 */

const SOMETHING_FORBIDDEN: ForbiddenTokens = {
  imports: ["node:fs"],
  propertyAccess: [],
  newExpressions: [],
  callExpressions: [],
};

const NOTHING_FORBIDDEN: ForbiddenTokens = {
  imports: [],
  importPrefixes: [],
  propertyAccess: [],
  newExpressions: [],
  callExpressions: [],
};

describe("vacuousRules — a rule that constrains nothing", () => {
  test("a purity closure that forbids nothing is refused, by name", () => {
    const found = vacuousRules({
      purityClosures: [
        { id: "allows-everything", entryPoints: ["src/a.ts"], forbidden: NOTHING_FORBIDDEN },
      ],
    });
    const finding = found.get("allows-everything");
    expect(finding).toBeDefined();
    expect(finding?.token).toBe("purityClosures");
    expect(finding?.message).toContain("forbids no import");
    expect(finding?.message).toContain("never a pass");
    // The finding is locatable: it points at the rule's own declared target.
    expect(finding?.file).toBe("src/a.ts");
  });

  test("an allowlist makes a purity closure non-vacuous even with an empty denylist", () => {
    // It refuses every global and module it does not name, so it always constrains.
    const found = vacuousRules({
      purityClosures: [
        {
          id: "allowlist-only",
          entryPoints: ["src/a.ts"],
          forbidden: NOTHING_FORBIDDEN,
          allowed: { globals: [], globalMembers: {}, externalImports: [] },
        },
      ],
    });
    expect(found.has("allowlist-only")).toBe(false);
  });

  test("a purity closure with no entry points is refused", () => {
    const found = vacuousRules({
      purityClosures: [{ id: "walks-nothing", entryPoints: [], forbidden: SOMETHING_FORBIDDEN }],
    });
    expect(found.get("walks-nothing")?.message).toContain("no entry points");
  });

  test("one forbidden token anywhere in the set is enough to be non-vacuous", () => {
    // Each arm of ForbiddenTokens must count on its own, or emptying four of five
    // would read as "still checking" while the rule had almost stopped.
    const arms: ForbiddenTokens[] = [
      { ...NOTHING_FORBIDDEN, imports: ["node:fs"] },
      { ...NOTHING_FORBIDDEN, importPrefixes: ["@acme/"] },
      { ...NOTHING_FORBIDDEN, propertyAccess: ["Date.now"] },
      { ...NOTHING_FORBIDDEN, newExpressions: ["Date"] },
      { ...NOTHING_FORBIDDEN, callExpressions: ["fetch"] },
    ];
    for (const forbidden of arms) {
      const found = vacuousRules({
        purityClosures: [{ id: "r", entryPoints: ["src/a.ts"], forbidden }],
      });
      expect(found.size).toBe(0);
    }
  });

  test("a file invariant that requires and forbids nothing is refused", () => {
    const found = vacuousRules({
      purityClosures: [],
      fileInvariants: [
        {
          id: "checks-nothing",
          file: "src/dash.ts",
          literalsRequired: [],
          literalsForbidden: [],
          membersForbidden: [],
        },
      ],
    });
    expect(found.get("checks-nothing")?.message).toContain("requires nothing and forbids nothing");
  });

  test("a source-encoding rule with no roots is refused", () => {
    const found = vacuousRules({
      purityClosures: [],
      sourceEncoding: [{ id: "scans-nothing", roots: [] }],
    });
    expect(found.get("scans-nothing")?.message).toContain("no roots");
  });

  test("a config whose every rule constrains something yields nothing", () => {
    const found = vacuousRules({
      purityClosures: [{ id: "p", entryPoints: ["src/a.ts"], forbidden: SOMETHING_FORBIDDEN }],
      fileInvariants: [
        {
          id: "f",
          file: "src/b.ts",
          literalsRequired: ["must-stay"],
          literalsForbidden: [],
          membersForbidden: [],
        },
      ],
      sourceEncoding: [{ id: "s", roots: ["src"] }],
    });
    expect(found.size).toBe(0);
  });
});

describe("run — a gate that measured nothing cannot report OK", () => {
  /**
   * A resolvable entry point, so the only thing wrong with the rule is that it
   * forbids nothing. Pointing at a missing file would also trip the engine's older
   * unresolvable-target refusal (decision #132), and a test that passes because
   * some *other* guard fired is not a test of this one.
   *
   * Anchored to this package, not to the working directory: the entry used to be a
   * path inside the host repository, resolved from its root, and it named nothing
   * once the folder stood alone — both arms below went red in the published copy only.
   */
  const ENGINE_ROOT = resolve(import.meta.dir, "..");
  const RESOLVABLE = "src/runner.ts";

  test("a vacuous rule makes the whole run non-ok, and is the only finding", () => {
    const config: IntegrityConfig = {
      purityClosures: [{ id: "vacuous", entryPoints: [RESOLVABLE], forbidden: NOTHING_FORBIDDEN }],
    };
    const result = run(config, ENGINE_ROOT);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.checkId).toBe("vacuous");
    expect(result.findings[0]?.token).toBe("purityClosures");
    // It really did read the closure — this is blindness with the lights on.
    expect(result.results[0]?.filesScanned).toBeGreaterThan(0);
  });

  test("the refusal is attached to its own check, not appended as an orphan", () => {
    const config: IntegrityConfig = {
      purityClosures: [{ id: "vacuous", entryPoints: [RESOLVABLE], forbidden: NOTHING_FORBIDDEN }],
    };
    const result = run(config, ENGINE_ROOT);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.checkId).toBe("vacuous");
    expect(result.results[0]?.findings).toHaveLength(1);
  });

  test("two independent defects in one rule are both reported", () => {
    // Forbidding nothing and pointing nowhere are separate faults: fixing the path
    // does not make the rule check anything, and giving it tokens does not make the
    // path resolve. Collapsing them would hide one behind the other.
    const config: IntegrityConfig = {
      purityClosures: [
        { id: "both", entryPoints: ["does/not/exist.ts"], forbidden: NOTHING_FORBIDDEN },
      ],
    };
    const result = run(config, ENGINE_ROOT);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.token).sort()).toEqual([
      "does/not/exist.ts",
      "purityClosures",
    ]);
  });

  test("a rule with no entry points reports vacuity once, not twice", () => {
    // It forbids nothing AND scans nothing, but that is one cause, so the
    // run-time refusal must stand down for the declaration-time one.
    const config: IntegrityConfig = {
      purityClosures: [{ id: "empty", entryPoints: [], forbidden: NOTHING_FORBIDDEN }],
    };
    const result = run(config, ENGINE_ROOT);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("purityClosures");
  });

  test("a non-vacuous rule over an empty tree is refused by the scan count", () => {
    // The run-time half, and the only route to it: this rule forbids everything
    // Unicode calls invisible and declares a real root, but the tree holds no file
    // to measure. Purity and file invariants cannot reach this guard, because each
    // already refuses an unresolvable target itself; an empty directory is clean,
    // resolvable and worthless.
    const root = mkdtempSync(join(tmpdir(), "empty-tree-"));
    mkdirSync(join(root, "inner"), { recursive: true });
    try {
      const result = run(
        { purityClosures: [], sourceEncoding: [{ id: "se", roots: ["inner"] }] },
        root,
      );
      expect(result.ok).toBe(false);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.token).toBe("filesScanned");
      expect(result.findings[0]?.checkId).toBe("se");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
