import { describe, expect, test } from "bun:test";
import { runFileInvariants } from "../src/checks/file-invariants";
import type { CheckResult, FileInvariantRule } from "../src/types";
import { tree } from "./tree";

/**
 * Which spellings of a member and which literals the presence check sees. Synthetic
 * files only (build brief D4); the host project's real invariant has its own arm in
 * the private config's mutation suite.
 */

function check(source: string, rule: Partial<FileInvariantRule>): CheckResult {
  const { root, cleanup } = tree({ "src/render.ts": source });
  try {
    return runFileInvariants(root, {
      id: "render",
      file: "src/render.ts",
      literalsRequired: [],
      literalsForbidden: [],
      membersForbidden: [],
      ...rule,
    });
  } finally {
    cleanup();
  }
}

describe("membersForbidden — every literal spelling of the member", () => {
  const SINK = { membersForbidden: ["innerHTML"] };

  for (const [spelling, source] of Object.entries({
    "a dot": "export const f = (el: any, x: string) => { el.innerHTML = x; };\n",
    "a string key": 'export const f = (el: any, x: string) => { el["innerHTML"] = x; };\n',
    "a template key": "export const f = (el: any, x: string) => { el[`innerHTML`] = x; };\n",
    "an object key":
      "export const f = (el: any, x: string) => Object.assign(el, { innerHTML: x });\n",
    "a shorthand key":
      "export const f = (el: any, innerHTML: string) => Object.assign(el, { innerHTML });\n",
    "a destructured name":
      "export const f = (el: any) => { const { innerHTML } = el; return innerHTML; };\n",
    "a renamed destructuring":
      "export const f = (el: any) => { const { innerHTML: h } = el; return h; };\n",
  })) {
    test(spelling, () => {
      expect(check(source, SINK).findings.map((finding) => finding.token)).toEqual(["innerHTML"]);
    });
  }

  test("the control: no such member, no finding", () => {
    const source = "export const f = (el: any, x: string) => { el.textContent = x; };\n";
    expect(check(source, SINK).findings).toEqual([]);
  });
});

describe("literals — text contains, a number equals", () => {
  test("a number does not carry a longer number that contains its digits", () => {
    const result = check("export const port = 14050;\n", { literalsRequired: ["405"] });
    expect(result.findings.map((finding) => finding.token)).toEqual(["405"]);
  });

  test("the number itself does", () => {
    expect(check("export const status = 405;\n", { literalsRequired: ["405"] }).findings).toEqual(
      [],
    );
  });

  test("text still matches inside a longer string, as a header directive must", () => {
    const source = "export const csp = \"default-src 'none'; frame-ancestors 'none'\";\n";
    expect(check(source, { literalsRequired: ["default-src 'none'"] }).findings).toEqual([]);
  });
});
