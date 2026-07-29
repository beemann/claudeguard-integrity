import type { ForbiddenTokens, IntegrityConfig } from "./src/types";

/**
 * The gate, held over its own source. Run in this package's CI.
 *
 * Two checks, and the second one is the point. The README opens by claiming this tool
 * has "no model in the decision path… no network, no telemetry, no clock". A claim
 * like that, in a tool built on the premise that invariants must be *checked* rather
 * than promised, has no business being a sentence in a README.
 */

/**
 * Determinism for a program whose job is reading files.
 *
 * The shipped {@link FORBIDDEN_NONDETERMINISM} set forbids `readFileSync` and the `fs`
 * imports, which is right for the code most projects hold pure and wrong here: reading
 * the tree under judgement is this program's **input**, not a side channel. An earlier
 * draft of this file used that as a reason to skip the check entirely. That was the
 * wrong conclusion — the answer to "the stock rule does not fit" is a fitted rule, not
 * an unchecked claim.
 *
 * So: no clock, no entropy, no network, no timers. Same run, same tree, same findings —
 * which is the property that lets this sit beside a statistical reviewer and mean
 * something different from it. File reads stay allowed, deliberately and narrowly.
 */
const NO_CLOCK_NO_ENTROPY_NO_NETWORK: ForbiddenTokens = {
  imports: ["node:net", "node:http", "node:https", "node:dgram", "node:tls"],
  propertyAccess: [
    "Date.now",
    "performance.now",
    "process.hrtime",
    "Bun.nanoseconds",
    "Math.random",
    "crypto.getRandomValues",
    "crypto.randomUUID",
    "Bun.serve",
  ],
  newExpressions: ["Date"],
  callExpressions: [
    "Date",
    "fetch",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "randomUUID",
    "randomBytes",
    "randomInt",
    "getRandomValues",
  ],
};

const config: IntegrityConfig = {
  /**
   * Both entry points, not one. A closure through a single front door proves nothing
   * about the house: a clock reachable only from the MCP server would leave the CLI's
   * closure clean and ship anyway.
   */
  purityClosures: [
    {
      id: "engine-determinism",
      entryPoints: ["src/cli.ts", "src/mcp.ts"],
      forbidden: NO_CLOCK_NO_ENTROPY_NO_NETWORK,
    },
  ],

  /**
   * A tool that exists because invisible characters defeat review must not carry any
   * in its own tree. The defect it was written for reached a merged commit once.
   */
  sourceEncoding: [
    {
      id: "no-invisible-characters",
      roots: ["."],
      extensions: [".ts", ".json", ".md", ".yml"],
    },
  ],
};

export default config;
