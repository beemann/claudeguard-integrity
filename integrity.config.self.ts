import type { IntegrityConfig } from "./src/types";

/**
 * The gate, held over its own source. Run in this package's CI.
 *
 * Only `source-encoding` applies, and the omission is deliberate rather than lazy:
 * `purity-closure` with the shipped `FORBIDDEN_NONDETERMINISM` set would fire on this
 * engine by design, because reading files is what it *does* — `readFileSync` is its
 * job, not a leak. A dogfood config that forbade it would be theatre, and theatre in
 * a gate is worse than no gate: it produces a green badge that means nothing.
 *
 * What this one asserts is real and non-obvious: a tool whose whole reason to exist is
 * that invisible characters defeat review must not carry any in its own tree. The
 * defect it was written for reached a merged commit once already.
 */

const config: IntegrityConfig = {
  purityClosures: [],
  sourceEncoding: [
    {
      id: "no-invisible-characters",
      roots: ["."],
      extensions: [".ts", ".json", ".md", ".yml"],
    },
  ],
};

export default config;
