import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { INTERNALS, runSourceEncoding } from "../src/checks/source-encoding";
import type { SourceEncodingRule } from "../src/types";

/**
 * The `source-encoding` check exists because of a defect that passed every other
 * gate in this repo — lint, prettier, `tsc`, 1338 tests and the LLM diff gate all
 * read a raw NUL byte as ordinary text. Only `git` reacted, by silently classifying
 * the file as binary: no diff, no blame, so every later change to it would ship
 * unreviewed.
 *
 * These tests build the forbidden characters NUMERICALLY (`String.fromCharCode` /
 * `String.fromCodePoint`), never as literals. That is not a stylistic choice: this
 * file lives under `tools/`, which the check scans, so a literal here would fail the
 * very gate it tests.
 *
 * Three of these tests are falsification instruments whose truth lies OUTSIDE this
 * file, because a hand-written expectation can only ever agree with a hand-written
 * implementation: `the coverage floor` asserts a fixed list of code points still fires
 * against the runtime's Unicode tables (#181), `no named family outruns the coverage
 * rule` walks the entire code-point space (#181), and `invalid UTF-8` is checked
 * against raw bytes rather than against the decoded string the scan sees (#182).
 */

const NUL = String.fromCharCode(0x00);
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const WORD_JOINER = String.fromCharCode(0x2060);
const FUNCTION_APPLICATION = String.fromCharCode(0x2061); // invisible math operator (#181)
const TAG_LETTER_A = String.fromCodePoint(0xe0041); // Tags-block char — above the BMP (surrogate pair)
const GRINNING_FACE = String.fromCodePoint(0x1f600); // legit above-BMP emoji — must NOT trip the scan
const LRM = String.fromCharCode(0x200e);
const RLM = String.fromCharCode(0x200f);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const VARIATION_SELECTOR_1 = String.fromCharCode(0xfe00); // smuggling alphabet — forbidden
const EMOJI_PRESENTATION = String.fromCharCode(0xfe0f); // what makes an emoji an emoji — allowed

/** The shape a project should use: no extension list, so every file is read (#182). */
const RULE: SourceEncodingRule = { id: "no-invisible-characters", roots: ["."] };

function repoWith(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "cg-encoding-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

/** Skip count for one reason, or 0 when the check reported no such skip. */
function skipCount(
  result: { skipped?: readonly { reason: string; count: number }[] },
  part: string,
) {
  return result.skipped?.find((entry) => entry.reason.includes(part))?.count ?? 0;
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
    const root = repoWith({ "key.ts": `const key = \`\${a}${NUL}\${b}\`;\n` });
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

  test("dependency and build directories are not walked, and the skip is reported", () => {
    const root = repoWith({
      "node_modules/dep/index.ts": `vendored${NUL}code`,
      "dist/out.ts": `built${NUL}code`,
      "src/app.ts": "export const x = 1;\n",
    });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
    // A name-matched exclusion can hide a source directory called `build`, so it is
    // never silent: the count is in the report next to the scan count (#182).
    expect(skipCount(result, "excluded directory")).toBe(2);
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

  test("catches a word joiner (U+2060) — the zero-width cousin the gate used to miss (#164)", () => {
    const root = repoWith({ "wj.ts": `const a${WORD_JOINER}b = 1;\n` });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+2060");
  });

  test("catches a Unicode Tags-block char (U+E0041) — ASCII-smuggling above the BMP (#164)", () => {
    const root = repoWith({ "tag.ts": `const a = "x${TAG_LETTER_A}y";\n` });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+E0041");
    expect(result.findings[0]?.line).toBe(1);
  });

  test("a legitimate above-BMP emoji does NOT trip the code-point scan", () => {
    const root = repoWith({ "emoji.ts": `const smile = "${GRINNING_FACE}";\n` });
    expect(runSourceEncoding(root, RULE).findings).toEqual([]);
  });
});

describe("source-encoding — derived coverage (#181)", () => {
  test("THE MISS THAT MOTIVATED #181: U+2061, an invisible operator from rendered math", () => {
    // How it arrives in a repo: copying rendered LaTeX out of a chat pastes the
    // invisible FUNCTION APPLICATION between the function name and its bracket. The
    // enumerated rule stopped at U+2060 and let U+2061..2064 through.
    const root = repoWith({ "math.ts": `// ln${FUNCTION_APPLICATION}(x)\n` });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+2061");
  });

  test("directional marks are flagged — the same class as the overrides, revising #164", () => {
    // #164 recorded U+200E/200F as a deliberate boundary: markers, not overrides. #181
    // reverses it. They are not needed in AUTHORED source (an escape says the same
    // thing visibly), and the measured cost of forbidding them in this tree was zero.
    const root = repoWith({ "marks.ts": `const a = "x${LRM}y${RLM}z";\n` });
    const tokens = runSourceEncoding(root, RULE).findings.map((finding) => finding.token);
    expect(tokens).toEqual(["U+200E", "U+200F"]);
  });

  test("presentation selectors are allowed; the other fourteen selectors are not", () => {
    // The emoji argument justifies U+FE0E/U+FE0F and nothing else — U+FE00..FE0D are a
    // smuggling alphabet with one byte per selector.
    const root = repoWith({
      "allowed.ts": `const warn = "x${EMOJI_PRESENTATION}";\n`,
      "forbidden.ts": `const a = "x${VARIATION_SELECTOR_1}";\n`,
    });
    const findings = runSourceEncoding(root, RULE).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("forbidden.ts");
    expect(findings[0]?.token).toBe("U+FE00");
    expect(INTERNALS.ALWAYS_ALLOWED.has(0xfe0f)).toBe(true);
    expect(INTERNALS.ALWAYS_ALLOWED.has(0xfe00)).toBe(false);
  });

  test("THE COVERAGE FLOOR: every representative invisible still fires on this runtime", () => {
    // Its truth is the runtime's Unicode tables, not this file: each entry is a code
    // point Unicode marks invisible that the enumerated rule let through. A runtime
    // whose tables are older than `Default_Ignorable_Code_Point` expects would narrow
    // the gate SILENTLY — here it fails the suite instead.
    const floor = [
      0x0000, 0x0085, 0x00ad, 0x061c, 0x180e, 0x200b, 0x200e, 0x2028, 0x2061, 0x2065, 0x206a,
      0x3164, 0xfe00, 0xfeff, 0xffa0, 0xfff9, 0x110bd, 0x13430, 0x1d173, 0xe0001, 0xe0041, 0xe0080,
      0xe0100, 0xe01f0,
    ];
    const files: Record<string, string> = {};
    for (const code of floor) {
      files[`f${code.toString(16)}.ts`] = `const a = "x${String.fromCodePoint(code)}y";\n`;
    }
    const result = runSourceEncoding(repoWith(files), RULE);
    expect(result.filesScanned).toBe(floor.length);
    const caught = new Set(result.findings.map((finding) => finding.token));
    const missed = floor
      .map((code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`)
      .filter((name) => !caught.has(name));
    expect(missed).toEqual([]);
  });

  test("VISIBLE TEXT IS UNTOUCHED: diacritics, non-breaking space, dashes, emoji", () => {
    // The healthy-case check. A widened gate that flags Czech prose or a non-breaking
    // space is a regression dressed as a feature, so the negative controls are as
    // load-bearing as the positive ones.
    const benign = [0x0041, 0x00e9, 0x010d, 0x0159, 0x00a0, 0x2014, 0x2026, 0x1f600, 0xfe0e];
    const files: Record<string, string> = {};
    for (const code of benign) {
      files[`b${code.toString(16)}.ts`] = `const a = "x${String.fromCodePoint(code)}y";\n`;
    }
    const result = runSourceEncoding(repoWith(files), RULE);
    expect(result.filesScanned).toBe(benign.length);
    expect(result.findings).toEqual([]);
  });

  test("no named family outruns the coverage rule — a report cannot name what the gate misses", () => {
    // The families exist to make a finding say WHY; coverage belongs to
    // UNICODE_INVISIBLE alone. If a family claimed a code point the coverage rule does
    // not match, that family would be dead code pretending to be protection. Walked
    // over the whole space rather than a sample, because the interesting code points
    // are exactly the ones nobody thinks to sample.
    const overreaching: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates are not code points
      const claimed = INTERNALS.NAMED_CLASSES.some((klass) => klass.holds(code));
      if (claimed && !INTERNALS.UNICODE_INVISIBLE.test(String.fromCodePoint(code))) {
        overreaching.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
    expect(overreaching).toEqual([]);
  });
});

describe("source-encoding — derived FILE SET, no opt-in list (#182)", () => {
  test("THE HOLE #182 CLOSED: scripts, hooks and extensionless files are read", () => {
    // Measured on the host repo, the old extension list left 144 of 532 tracked files
    // unread — including the git hooks that run on every push, the Dockerfile, and the
    // runner of this very gate. None was dirty; all were invisible.
    const root = repoWith({
      "scripts/deploy.sh": `#!/bin/sh\necho ${BIDI_OVERRIDE}ok\n`,
      ".githooks/pre-push": `#!/bin/sh\nrun${ZERO_WIDTH}checks\n`,
      Dockerfile: `FROM oven/bun\nRUN echo ${NUL}\n`,
      "notes.txt": `plain${WORD_JOINER}text\n`,
    });
    const result = runSourceEncoding(root, RULE);
    expect(result.filesScanned).toBe(4);
    expect(result.findings.map((finding) => finding.file).sort()).toEqual([
      ".githooks/pre-push",
      "Dockerfile",
      "notes.txt",
      "scripts/deploy.sh",
    ]);
  });

  test("a declared binary extension is skipped — and the skip is COUNTED, never silent", () => {
    const root = repoWith({
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      "app.ts": "export const x = 1;\n",
    });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(1);
    expect(skipCount(result, "binary extension")).toBe(1);
  });

  test("an UNDECLARED binary is read and fails loudly — that is where a payload would sit", () => {
    const root = repoWith({ "blob.wat": Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x00]) });
    const result = runSourceEncoding(root, RULE);
    expect(result.filesScanned).toBe(1);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.token).toBe("U+0000");
  });

  test("INVALID UTF-8 is a finding — U+FFFD substitution used to walk straight past", () => {
    // The bytes are checked against a re-encode of their own decoding, so the truth is
    // the raw buffer and not the string the scan would otherwise see: a malformed
    // sequence decodes to a perfectly visible replacement character.
    const root = repoWith({ "bad.ts": Buffer.from([0x41, 0xc3, 0x28, 0x42]) });
    const result = runSourceEncoding(root, RULE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("invalid UTF-8");
    expect(result.findings[0]?.file).toBe("bad.ts");
  });

  test("a deprecated extensions list is honoured but cannot be quiet about what it skipped", () => {
    const root = repoWith({
      "app.ts": "export const x = 1;\n",
      "run.sh": `echo ${BIDI_OVERRIDE}\n`,
      "notes.txt": "plain\n",
    });
    const result = runSourceEncoding(root, { ...RULE, extensions: [".ts"] });
    expect(result.filesScanned).toBe(1);
    const complaint = result.findings.find((finding) => finding.token === "extensions");
    expect(complaint?.message).toContain("2 readable file(s) unread");
    expect(complaint?.message).toContain("place to hide");
    expect(skipCount(result, "deprecated")).toBe(2);
  });
});

describe("source-encoding — bounded exceptions (#182)", () => {
  test("a soft hyphen is flagged in code and allowed in prose, by extension", () => {
    const root = repoWith({
      "doc.md": `ig${SOFT_HYPHEN}nore\n`,
      "code.ts": `// ig${SOFT_HYPHEN}nore\n`,
    });
    const result = runSourceEncoding(root, { ...RULE, allowancesByExtension: { ".md": [0x00ad] } });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("code.ts");
    expect(result.findings[0]?.token).toBe("U+00AD");
  });

  test("AN ALLOWANCE CANNOT BE WIDENED INTO A DOOR: hard families are refused, as findings", () => {
    // The escape hatch is the obvious place to attack a gate: allow U+0000 for `.ts`
    // and the original defect is legal again. Refusing silently would be worse than
    // refusing loudly, so the config gets a finding and the allowance is not applied.
    const root = repoWith({ "a.ts": `const k = "${NUL}";\n` });
    const result = runSourceEncoding(root, {
      ...RULE,
      allowancesByExtension: { ".ts": [0x0000, 0x202e, 0xe0041, 0xfe00, 0x2028] },
    });
    const refusals = result.findings.filter((finding) => finding.message.includes("refused"));
    expect(refusals.map((finding) => finding.token).sort()).toEqual([
      "U+0000",
      "U+2028",
      "U+202E",
      "U+E0041",
      "U+FE00",
    ]);
    // And the character itself is still reported: the refusal is not cosmetic.
    expect(result.findings.some((finding) => finding.file === "a.ts")).toBe(true);
  });

  test("an allowance does not leak between rules through the classification memo", () => {
    // The memo caches the FAMILY of a code point, never whether some rule tolerated it.
    // If an allowance were ever folded into it, the prose rule would quietly legalise a
    // soft hyphen in code for the rest of the run.
    const root = repoWith({ "code.ts": `// ig${SOFT_HYPHEN}nore\n` });
    runSourceEncoding(root, { ...RULE, allowancesByExtension: { ".ts": [0x00ad] } });
    const strict = runSourceEncoding(root, RULE);
    expect(strict.findings.map((finding) => finding.token)).toEqual(["U+00AD"]);
  });

  test("declared attack data keeps its payload but still may not become unreviewable", () => {
    // A concealment corpus must hold the real bytes or it tests nothing. What it may
    // NOT hold is a control character, which is what makes git stop diffing a file.
    const root = repoWith({
      "corpus/attack.txt": `admin${BIDI_OVERRIDE}${TAG_LETTER_A}\n`,
      "corpus/broken.txt": `sample${NUL}\n`,
    });
    const result = runSourceEncoding(root, { ...RULE, dataPaths: ["corpus/"] });
    expect(result.filesScanned).toBe(2);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("corpus/broken.txt");
    expect(result.findings[0]?.token).toBe("U+0000");
    expect(skipCount(result, "attack/trace data")).toBe(2);
  });

  test("a script under a data path gets the FULL rule — the corpus is not a hiding place", () => {
    const root = repoWith({ "corpus/helper.sh": `echo ${BIDI_OVERRIDE}\n` });
    const result = runSourceEncoding(root, { ...RULE, dataPaths: ["corpus/"] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.token).toBe("U+202E");
  });

  test("the unallowable families are exactly the ones with no authored use", () => {
    const unallowable = (code: number) =>
      INTERNALS.UNALLOWABLE_CLASSES.some((klass) => klass.holds(code));
    for (const code of [0x0000, 0x0085, 0x202e, 0x2066, 0x061c, 0x2028, 0xe0041, 0xfe00]) {
      expect(unallowable(code)).toBe(true);
    }
    // Typography a project may legitimately need, and therefore may declare.
    for (const code of [0x00ad, 0x200b, 0x2060, 0x3164]) {
      expect(unallowable(code)).toBe(false);
    }
  });
});

describe("source-encoding — indirection is reported, not followed (#182)", () => {
  const root = repoWith({ "real.ts": "export const x = 1;\n" });
  let symlinkWorks = true;
  try {
    symlinkSync(join(root, "real.ts"), join(root, "link.ts"));
  } catch {
    symlinkWorks = false; // unprivileged Windows host; the gate runs in Docker anyway
  }

  test.skipIf(!symlinkWorks)(
    "a symlink is a finding — its real bytes were never in the diff",
    () => {
      const result = runSourceEncoding(root, RULE);
      expect(result.filesScanned).toBe(1);
      const symlink = result.findings.find((finding) => finding.token === "symlink");
      expect(symlink?.file).toBe("link.ts");
      expect(skipCount(result, "symlink")).toBe(1);
    },
  );
});
