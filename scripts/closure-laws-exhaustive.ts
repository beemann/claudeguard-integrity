import { closureOver, type EdgeReader } from "../src/graph";

/**
 * The closure law sweep at a size the test suite cannot afford.
 *
 * `test/closure-laws.test.ts` sweeps every directed graph on up to four nodes with
 * five laws each, which is 1.8 M assertions in under three seconds and belongs in
 * the standard check. Five nodes is 32^5 = 33 554 432 graphs, so this is a script
 * run on demand rather than a gate: `bun run bench:closure-laws`.
 *
 * It holds the strongest law only — agreement with an independent breadth-first
 * fixpoint over the same edge relation, which subsumes reflexivity and dedup for
 * any graph where it holds. The monotonicity sweep is quadratic in the node count
 * and stays at four nodes, where it is complete.
 *
 * Exit code is the verdict: 0 when every graph agreed, 1 with a counterexample
 * printed. A sweep that found nothing prints how many graphs it actually visited,
 * because a sweep reporting success over an empty space is the failure mode this
 * whole family of checks exists to refuse.
 */

const N = Number(process.argv[2] ?? "5");
const ROW_SPACE = 1 << N;
const TOTAL = ROW_SPACE ** N;

/** Node identities, allocated once — building them per graph dominates the cost. */
const NAMES: string[] = Array.from({ length: N }, (_, i) => `n${String(i)}`);

/** Reusable edge lists, rewritten per graph instead of reallocated. */
const EDGES: string[][] = Array.from({ length: N }, () => []);
const INDEX = new Map<string, number>(NAMES.map((n, i) => [n, i]));

const reader: EdgeReader = (node) => {
  const i = INDEX.get(node);
  return i === undefined ? undefined : EDGES[i];
};

/** The oracle: reachability from node 0, over the same rows, by plain BFS. */
function fixpoint(rows: readonly number[]): Set<number> {
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === undefined) break;
    const row = rows[node] ?? 0;
    for (let j = 0; j < N; j += 1) {
      if ((row & (1 << j)) !== 0 && !seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return seen;
}

const rows: number[] = new Array<number>(N).fill(0);
let visited = 0;
const started = Date.now();

for (let code = 0; code < TOTAL; code += 1) {
  let rest = code;
  for (let i = 0; i < N; i += 1) {
    const row = rest % ROW_SPACE;
    rest = Math.floor(rest / ROW_SPACE);
    rows[i] = row;
    const edges = EDGES[i];
    if (edges === undefined) continue;
    edges.length = 0;
    for (let j = 0; j < N; j += 1) {
      if ((row & (1 << j)) !== 0) {
        edges.push(NAMES[j] ?? "");
      }
    }
  }

  const got = closureOver([NAMES[0] ?? ""], reader);
  const oracle = fixpoint(rows);
  if (got.length !== oracle.size || got.some((n) => !oracle.has(INDEX.get(n) ?? -1))) {
    console.error(`closure-laws: DISAGREEMENT at n=${String(N)}`);
    console.error(`  graph rows   : ${JSON.stringify(rows)}`);
    console.error(`  walker       : ${JSON.stringify(got)}`);
    console.error(`  independent  : ${JSON.stringify([...oracle].map((i) => NAMES[i]))}`);
    process.exit(1);
  }
  visited += 1;
}

const elapsed = (Date.now() - started) / 1000;
if (visited !== TOTAL) {
  console.error(
    `closure-laws: swept ${String(visited)} of ${String(TOTAL)} graphs — an incomplete sweep is not a pass`,
  );
  process.exit(1);
}
console.log(
  `closure-laws: OK — ${String(TOTAL)} graph(s) on ${String(N)} nodes, ` +
    `walker agrees with an independent fixpoint on every one (${elapsed.toFixed(1)}s)`,
);
