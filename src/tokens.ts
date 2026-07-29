import type { ForbiddenTokens } from "./types";

/**
 * The generic non-determinism / I/O token set (build brief §4.4) — a shippable,
 * project-agnostic default: "no clock, no random, no I/O in the closure". It encodes
 * ordinary determinism hygiene rather than any one project's know-how, which is why
 * it ships with the engine; a project parametrises WHICH closures to hold it over
 * via its own config (build brief D4).
 *
 * Content-keyword matching is deliberately out of scope: "must not decide by reading
 * the payload" is a real invariant in some systems, but it is not expressible as a
 * token, and a check that guesses at it would trade the zero-false-positive rule for
 * coverage. Import closure plus these purity tokens are the mechanical core.
 */
export const FORBIDDEN_NONDETERMINISM: ForbiddenTokens = {
  // I/O module boundaries — a value import of any of these opens a side channel.
  imports: [
    "fs",
    "node:fs",
    "node:fs/promises",
    "node:net",
    "node:http",
    "node:https",
    "node:dgram",
    "node:tls",
    "node:crypto",
    "bun:sqlite",
  ],
  // Clock + entropy read through a member access.
  propertyAccess: [
    "Date.now",
    "performance.now",
    "process.hrtime",
    "Bun.nanoseconds",
    "Math.random",
    "crypto.getRandomValues",
    "crypto.randomUUID",
    "Bun.serve",
    "Bun.file",
  ],
  // Clock construction.
  newExpressions: ["Date"],
  // Bare calls (identifier imported then invoked, or a global) — clock, entropy, I/O, timers.
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
    "readFileSync",
    "Database",
  ],
};
