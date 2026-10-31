import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { ambientReferences } from "../src/ambient";

/**
 * The classification under allowlist mode: which names in a file are globals.
 *
 * Each case below is a position where the TypeScript binder answers "no symbol" for
 * something that is NOT a global (a member name, a label, the key side of a
 * destructuring), or "a symbol" for something that IS one (the property side of a
 * shorthand, a `declare`d name). Both were measured against the binder before this
 * module was written; these pin the answers.
 */

function globalsIn(source: string, fileName = "/virtual/a.ts"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return ambientReferences(sf).map((ref) =>
    ref.member === undefined ? ref.name : `${ref.name}.${ref.member}`,
  );
}

describe("ambientReferences — what is a global", () => {
  test("an undeclared name, with the member read through it", () => {
    expect(globalsIn("export const t = Date.now();")).toEqual(["Date.now"]);
    expect(globalsIn('export const t = Date["now"]();')).toEqual(["Date.now"]);
    expect(globalsIn("export const t = Date[`now`]();")).toEqual(["Date.now"]);
  });

  test("a use that is not exactly a member read carries no member", () => {
    expect(globalsIn("const D = Date;")).toEqual(["Date"]);
    expect(globalsIn("const k = 'now'; export const t = Date[k]();")).toEqual(["Date"]);
    expect(globalsIn("export const t = globalThis.Date.now();")).toEqual(["globalThis.Date"]);
  });

  test("the property side of a shorthand reads the binding", () => {
    expect(globalsIn("export const o = { fetch };")).toEqual(["fetch"]);
  });

  test("a `declare`d name emits no code, so it is still a global", () => {
    expect(globalsIn("declare const Bun: { x: number };\nexport const b = Bun.x;")).toEqual([
      "Bun.x",
    ]);
    expect(
      globalsIn("declare global { var tick: number }\nexport const t = tick;\nexport {};"),
    ).toEqual(["tick"]);
  });

  test("a class heritage is a run-time read; an interface heritage is not", () => {
    expect(globalsIn("class K extends Date {}")).toEqual(["Date"]);
    expect(globalsIn("interface I extends Date {}")).toEqual([]);
  });

  test("import.meta is reported as a global named import.meta", () => {
    expect(globalsIn("export const u = import.meta.url;")).toEqual(["import.meta.url"]);
  });

  test("synthetic globals the binder knows without a declaration", () => {
    expect(globalsIn("export const u = [undefined, globalThis];")).toEqual([
      "undefined",
      "globalThis",
    ]);
  });
});

describe("ambientReferences — what is not", () => {
  test("declared names, wherever they are declared", () => {
    expect(
      globalsIn(
        [
          'import { readFile as rf } from "node:fs";',
          'import def, * as ns from "./x";',
          "function hoisted() { return later; }",
          "const later = 1;",
          "export const all = [rf, def, ns, hoisted];",
          "try { hoisted(); } catch (error) { void error; }",
          "for (const item of all) { void item; }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a local shadows the global of the same name", () => {
    expect(globalsIn("const fetch = (u: string) => u;\nexport const r = fetch('x');")).toEqual([]);
  });

  test("names that are not references: members, labels, keys, specifiers", () => {
    expect(
      globalsIn(
        [
          "const o = { now: 1 };",
          "export const n = o.now;",
          "const { now: renamed } = o;",
          "export { renamed };",
          "outer: for (;;) { break outer; }",
          'export { readFileSync as rfs } from "node:fs";',
          'import data from "./data.json" with { type: "json" };',
          "export const d = data;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("type positions are erased at build", () => {
    expect(
      globalsIn(
        [
          "export type T = { at: Date; f: typeof fetch };",
          "export const cast = (x: unknown) => x as Date;",
          "export function f(this: Window, p: Promise<Date>): Date | undefined { return undefined; }",
        ].join("\n"),
      ),
    ).toEqual(["undefined"]);
  });

  test("JSX attribute names and intrinsic tags are not references; components are", () => {
    expect(
      globalsIn("export const v = <div className='x'><Widget /></div>;", "/virtual/a.tsx"),
    ).toEqual(["Widget"]);
  });
});
