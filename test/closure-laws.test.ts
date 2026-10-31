import { describe, expect, test } from "bun:test";
import { closureOver, type EdgeReader } from "../src/graph";

/**
 * The closure walker, checked against laws rather than examples.
 *
 * The oracle is **not** this walker. It is an independent breadth-first fixpoint
 * written below over the same declared edge relation, plus three properties that
 * follow from the definition of a reflexive-transitive closure and not from any
 * implementation. Two different algorithms agreeing over a complete input space is
 * corroboration; one algorithm passing examples it was shown is attestation.
 *
 * The sweep is **exhaustive, not sampled**: every directed graph on up to four
 * nodes, self-loops and cycles included — 1 + 16 + 512 + 65 536 graphs. That is
 * affordable only because the traversal takes an injected reader; through a
 * filesystem it was 1.75 ms per graph, and a complete sweep of the five-node space
 * would be roughly 17 hours. `bun run bench:closure-laws` does five nodes.
 *
 * Why small graphs are worth a complete sweep: a traversal bug that survives every
 * four-node shape has to depend on something other than shape, and shape is what
 * this code is made of — order of discovery, revisiting, cycles, unreachable
 * components, self-edges.
 */

/** A graph on `n` nodes as adjacency bitmasks: edge i to j iff `bits[i] & (1 << j)`. */
type Graph = readonly number[];

/** Node names, so the traversal is exercised on opaque identities rather than indices. */
const name = (i: number): string => `n${String(i)}`;

/** Every directed graph on `n` nodes. */
function* allGraphs(n: number): Generator<Graph> {
  const rowSpace = 1 << n;
  const total = rowSpace ** n;
  for (let code = 0; code < total; code += 1) {
    const bits: number[] = [];
    let rest = code;
    for (let i = 0; i < n; i += 1) {
      bits.push(rest % rowSpace);
      rest = Math.floor(rest / rowSpace);
    }
    yield bits;
  }
}

/** An in-memory reader: every node exists, and its edges are the row's set bits. */
function readerFor(g: Graph): EdgeReader {
  const byName = new Map<string, readonly string[]>();
  for (let i = 0; i < g.length; i += 1) {
    const edges: string[] = [];
    for (let j = 0; j < g.length; j += 1) {
      if (((g[i] ?? 0) & (1 << j)) !== 0) {
        edges.push(name(j));
      }
    }
    byName.set(name(i), edges);
  }
  return (node) => byName.get(node);
}

/** The oracle: reachability from node 0 by plain breadth-first search. */
function fixpoint(g: Graph, from = 0): Set<string> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    for (let j = 0; j < g.length; j += 1) {
      if (((g[node] ?? 0) & (1 << j)) !== 0 && !seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return new Set([...seen].map(name));
}

const sameSet = (a: Iterable<string>, b: Set<string>): boolean => {
  const left = [...a];
  return left.length === b.size && left.every((x) => b.has(x));
};

describe("closureOver — laws over every graph on up to four nodes", () => {
  for (const n of [1, 2, 3, 4]) {
    test(`n = ${String(n)}: agrees with an independent fixpoint, everywhere`, () => {
      let checked = 0;
      for (const g of allGraphs(n)) {
        const got = closureOver([name(0)], readerFor(g));
        if (!sameSet(got, fixpoint(g))) {
          // Compared only on disagreement, and reported with the graph that caused
          // it: a failing law is useless without its counterexample, and asserting
          // on all 65 536 graphs unconditionally would cost more than the sweep.
          expect({ graph: g, closure: [...got].sort() }).toEqual({
            graph: g,
            closure: [...fixpoint(g)].sort(),
          });
        }
        checked += 1;
      }
      expect(checked).toBe((1 << n) ** n);
    });

    test(`n = ${String(n)}: the entry point is always in its own closure`, () => {
      for (const g of allGraphs(n)) {
        expect(closureOver([name(0)], readerFor(g))).toContain(name(0));
      }
    });

    test(`n = ${String(n)}: no node appears twice, however many paths reach it`, () => {
      for (const g of allGraphs(n)) {
        const got = closureOver([name(0)], readerFor(g));
        expect(new Set(got).size).toBe(got.length);
      }
    });

    test(`n = ${String(n)}: adding an edge never shrinks the closure`, () => {
      for (const g of allGraphs(n)) {
        const before = new Set(closureOver([name(0)], readerFor(g)));
        for (let i = 0; i < n; i += 1) {
          for (let j = 0; j < n; j += 1) {
            if (((g[i] ?? 0) & (1 << j)) !== 0) continue;
            const bigger = g.map((bits, k) => (k === i ? bits | (1 << j) : bits));
            const after = new Set(closureOver([name(0)], readerFor(bigger)));
            for (const node of before) {
              expect(after.has(node)).toBe(true);
            }
          }
        }
      }
    });

    test(`n = ${String(n)}: the closure of a closure adds nothing`, () => {
      for (const g of allGraphs(n)) {
        const once = closureOver([name(0)], readerFor(g));
        const twice = closureOver(once, readerFor(g));
        expect(new Set(twice).size).toBe(new Set(once).size);
      }
    });
  }
});

describe("closureOver — what the reader is allowed to say", () => {
  test("a node the reader does not know is skipped, not recorded", () => {
    // The property decision #132 is about, at traversal level: a closure may not
    // list a file it never opened.
    const reader: EdgeReader = (node) => (node === "a" ? ["ghost"] : undefined);
    expect(closureOver(["a"], reader)).toEqual(["a"]);
  });

  test("a missing entry point yields an empty closure, not a phantom one", () => {
    expect(closureOver(["nowhere"], () => undefined)).toEqual([]);
  });

  test("a file that imports nothing is still recorded", () => {
    expect(closureOver(["a"], (node) => (node === "a" ? [] : undefined))).toEqual(["a"]);
  });

  test("a self-edge terminates", () => {
    expect(closureOver(["a"], (node) => (node === "a" ? ["a"] : undefined))).toEqual(["a"]);
  });

  test("a two-node cycle terminates and records both", () => {
    const reader: EdgeReader = (node) => (node === "a" ? ["b"] : node === "b" ? ["a"] : undefined);
    expect(closureOver(["a"], reader).sort()).toEqual(["a", "b"]);
  });

  test("several entry points are all closed over, first-seen order preserved", () => {
    const reader: EdgeReader = (node) =>
      node === "a" ? ["c"] : node === "b" ? ["c"] : node === "c" ? [] : undefined;
    expect(closureOver(["a", "b"], reader)).toEqual(["a", "b", "c"]);
  });

  test("an unreachable component stays out", () => {
    const reader: EdgeReader = (node) => (node === "a" || node === "island" ? [] : undefined);
    expect(closureOver(["a"], reader)).toEqual(["a"]);
  });
});
