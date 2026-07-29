import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runSourceEncoding } from "../src/checks/source-encoding";
import type { SourceEncodingRule } from "../src/types";

/**
 * The `source-encoding` check exists because of a defect that passed every other
 * gate in this repo — lint, prettier, `tsc`, 1338 tests and the LLM diff gate all
 * read a raw NUL byte as ordinary text. Only `git` reacted, by silently classifying
 * the file as binary: no diff, no blame, so every later change to it would ship
 * unreviewed.
 *
 * These tests build the forbidden characters NUMERICALLY (`String.fromCharCode`),
 * never as literals. That is not a stylistic choice: this file lives under `tools/`,
 * which the check scans, so a literal here would fail the very gate it tests.
 */

const NUL = String.fromCharCode(0x00);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

const RULE: SourceEncodingRule = {
  id: "no-invisible-characters",
  roots: ["."],
  extensions: [".ts"],
};

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cg-encoding-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

describe("source-encoding — the class of defect no AST check can see", () => {
  test("a clean file produces no findings, and the scan is provably not inert", () => {
    const root = repoWith({ "a.ts": "export const x = 1;\nexport const y = 2;\n" });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  test("THE REGRESSION: a raw NUL inside a template literal is caught", () => {
    // The exact shape that shipped: a composite key whose delimiter was a raw byte.
    const root = repoWith({
      "key.ts": `const key = \`\${a}${NUL}\${b}\`;\n`,
    });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+0000");
    expect(result.findings[0]?.file).toBe("key.ts");
    expect(result.findings[0]?.line).toBe(1);
    expect(result.findings[0]?.message).toContain("binary");
  });

  test("catches a bidi override — Trojan Source, CVE-2021-42574", () => {
    const root = repoWith({ "t.ts": `// safe\n// ${BIDI_OVERRIDE}admin\n` });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+202E");
    expect(result.findings[0]?.line).toBe(2);
  });

  test("catches zero-width characters and a byte-order mark", () => {
    const root = repoWith({
      "z.ts": `const a${ZERO_WIDTH}b = 1;\n`,
      "b.ts": `${BOM}const c = 2;\n`,
    });
    const tokens = runSourceEncoding(root, RULE).findings.map((finding) => finding.token);
    expect(tokens).toEqual(["U+FEFF", "U+200B"]); // sorted walk: b.ts before z.ts
  });

  test("tab, newline and carriage return are allowed — they are visible in a diff", () => {
    const root = repoWith({ "ws.ts": "const a = 1;\r\n\tconst b = 2;\r\n" });
    expect(runSourceEncoding(root, RULE).findings).toEqual([]);
  });

  test("only configured extensions are read", () => {
    const root = repoWith({ "notes.txt": `plain${NUL}text`, "ok.ts": "export const x = 1;\n" });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  test("dependency and build directories are not walked", () => {
    const root = repoWith({
      "node_modules/dep/index.ts": `vendored${NUL}code`,
      "dist/out.ts": `built${NUL}code`,
      "src/app.ts": "export const x = 1;\n",
    });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
  });

  test("A MISSING ROOT IS A FINDING, NOT A SKIP — a blind gate must not read as green", () => {
    const root = repoWith({ "packages/a.ts": "export const x = 1;\n" });
    const result = runSourceEncoding(root, { ...RULE, roots: ["packages", "does-not-exist"] });
    // The real root still gets scanned; the missing one is reported rather than skipped.
    expect(result.filesScanned).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("does-not-exist");
    expect(result.findings[0]?.message).toContain("not the same as passing");
  });

  test("findings per file are capped so one binary file cannot flood the report", () => {
    const root = repoWith({ "blob.ts": NUL.repeat(50) });
    expect(runSourceEncoding(root, RULE).findings).toHaveLength(10);
  });
});
