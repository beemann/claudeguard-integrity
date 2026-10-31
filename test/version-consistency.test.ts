import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One version, three places that have to agree.
 *
 * `package.json` is the authority. The plugin manifest is a separate static file
 * that ships beside it, and the MCP server announces a version to its clients.
 * Keeping those in step by hand is an enumeration, and enumerations in this engine
 * have already drifted twice (#181 missed 3802 code points, #182 missed 144 files).
 * They had drifted here too: the manifest said `0.2.0` while the package said
 * `0.2.0` and the server announced `0.0.0` — a number that was never true.
 *
 * The server now derives its answer, so this test guards the one copy that cannot
 * be derived: the plugin manifest.
 */

const ROOT = resolve(import.meta.dir, "..");

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")) as Record<string, unknown>;

describe("version consistency", () => {
  test("the package declares a semantic version", () => {
    const version = readJson("package.json")["version"];
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test("the plugin manifest matches the package", () => {
    expect(readJson(".claude-plugin/plugin.json")["version"]).toBe(
      readJson("package.json")["version"],
    );
  });

  test("the MCP surface carries no hard-coded version literal", () => {
    // Derivation, not a matching literal: a literal that happens to agree today
    // is the same enumeration one indirection further along.
    const source = readFileSync(resolve(ROOT, "src/mcp.ts"), "utf8");
    expect(source).toContain("engineVersion()");
    expect(source).not.toMatch(/version:\s*"\d+\.\d+\.\d+"/);
  });

  test("the plugin manifest and the package agree on the licence", () => {
    // Licence only. The package is `@claudeguard/integrity` and the plugin is
    // `claudeguard-integrity`; any rule mapping one to the other would be a
    // convention invented by this test rather than a property either file claims,
    // and a gate's own suite is the last place to assert something nobody promised.
    const pkg = readJson("package.json");
    expect(readJson(".claude-plugin/plugin.json")["license"]).toBe(pkg["license"]);
  });
});
