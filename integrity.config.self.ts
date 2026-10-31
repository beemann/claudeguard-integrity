import { PURE_SURFACE } from "./src/tokens";
import type { AllowedSurface, ForbiddenTokens, IntegrityConfig } from "./src/types";

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

/**
 * Everything the engine reaches outside its own code, named — measured by running this
 * closure in allowlist mode against the pure surface and reading what it refused.
 *
 * The denylist above names the usual spellings of a clock; this refuses every other
 * one, because the README of this very tool says a denylist alone is not enough for a
 * closure whose purity is load-bearing. Holding its own determinism to less would be
 * the promise this file exists to replace.
 *
 * What is granted, and why it is not a side channel: `node:fs` reads the tree under
 * judgement and `node:path`/`node:url` resolve it; `typescript` parses it; the MCP SDK
 * is the server surface. `process` gives the arguments, the default root and the exit
 * code, `console` the report, `Buffer.from` a byte view for the encoding scan, and
 * `import.meta` the package's own location and whether it runs as the entry. No
 * network module, no clock, no entropy, no timer and no environment variable is on it.
 */
const ENGINE_SURFACE: AllowedSurface = {
  ...PURE_SURFACE,
  globalMembers: {
    ...PURE_SURFACE.globalMembers,
    process: ["argv", "cwd", "exit"],
    console: ["log", "error"],
    Buffer: ["from"],
    "import.meta": ["dir", "main"],
  },
  externalImports: [
    "node:fs",
    "node:path",
    "node:url",
    "typescript",
    "@modelcontextprotocol/sdk/server/index.js",
    "@modelcontextprotocol/sdk/server/stdio.js",
    "@modelcontextprotocol/sdk/types.js",
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
      allowed: ENGINE_SURFACE,
      // Both surfaces import the config they are handed by computed path. It is the
      // engine's input, not its code, so the closure stops there — declared, counted
      // in the report, and refused the moment either load disappears.
      computedLoadsAllowedIn: ["src/cli.ts", "src/mcp.ts"],
    },
  ],

  /**
   * A tool that exists because invisible characters defeat review must not carry any
   * in its own tree. The defect it was written for reached a merged commit once.
   */
  sourceEncoding: [
    {
      // No `extensions` list: the engine reads every file in its own tree (#182). A
      // tool whose own gate was opt-in could not credibly tell a project that opt-in
      // lists are where payloads hide. No allowance either — not even the prose one a
      // host project may need, because this tree's prose is the tool's own docs and can
      // simply be written with escapes.
      id: "no-invisible-characters",
      roots: ["."],
    },
  ],
};

export default config;
