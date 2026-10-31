import type { AllowedSurface, ForbiddenTokens } from "./types";

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

/**
 * The generic allowlist for a closure held to "no clock, no random, no I/O, no host
 * dependence" — the allowlist-mode counterpart of {@link FORBIDDEN_NONDETERMINISM}.
 * A project spreads it and adds what its own closure needs, each addition a reviewed
 * line in its config.
 *
 * It is written out rather than derived from the running engine on purpose. An
 * allowlist derived from `Object.getOwnPropertyNames(Math)` would grant whatever the
 * next runtime adds, unseen; written out, a new member is refused until someone adds
 * it. For an allowlist that is the safe direction — the opposite of the coverage
 * lists that had to be derived (a missing entry there was a silent pass).
 *
 * Left out deliberately: `Date` beyond `UTC` (a clock, and local-time getters that
 * read the host's time zone), `Date.parse` (implementation-defined for anything that
 * is not ISO, local time for date-times without an offset), `Math.random`, `Intl`
 * (host locale and time zone), `WeakRef` and `FinalizationRegistry` (observe the
 * garbage collector), `Atomics` and `SharedArrayBuffer` (cross-thread state),
 * `console` and every timer (side effects and scheduling), and everything the host
 * runtime adds (`process`, `Bun`, `crypto`, `performance`, `fetch`).
 */
export const PURE_SURFACE: AllowedSurface = {
  globals: [
    // Language values and the implicit per-function binding the binder exposes
    // without a declaration.
    "undefined",
    "NaN",
    "Infinity",
    "arguments",
    // Fundamental objects and collections.
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "BigInt",
    "Symbol",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "JSON",
    "RegExp",
    "Promise",
    "Proxy",
    // Errors.
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "URIError",
    "EvalError",
    "AggregateError",
    // Binary data and text codecs.
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "TextEncoder",
    "TextDecoder",
    // Pure global functions.
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "encodeURI",
    "decodeURI",
    "structuredClone",
  ],
  globalMembers: {
    Math: [
      "E",
      "LN10",
      "LN2",
      "LOG10E",
      "LOG2E",
      "PI",
      "SQRT1_2",
      "SQRT2",
      "abs",
      "acos",
      "acosh",
      "asin",
      "asinh",
      "atan",
      "atan2",
      "atanh",
      "cbrt",
      "ceil",
      "clz32",
      "cos",
      "cosh",
      "exp",
      "expm1",
      "floor",
      "fround",
      "hypot",
      "imul",
      "log",
      "log10",
      "log1p",
      "log2",
      "max",
      "min",
      "pow",
      "round",
      "sign",
      "sin",
      "sinh",
      "sqrt",
      "tan",
      "tanh",
      "trunc",
    ],
    Date: ["UTC"],
  },
  externalImports: [],
};

/**
 * Globals an allowlist may never grant, in either form. Each one reaches EVERY other
 * global (`globalThis` and the host aliases of the global object) or evaluates a
 * string as code (`eval`, `Function`), so allowing it would re-open everything the
 * allowlist closes. A config that tries is refused with a finding — the same bound
 * the source-encoding check puts on its own escape hatch.
 */
export const GLOBALS_NEVER_ALLOWED: readonly string[] = [
  "globalThis",
  "global",
  "self",
  "window",
  "eval",
  "Function",
];
