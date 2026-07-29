import { FORBIDDEN_NONDETERMINISM } from "./src/tokens";
import type { IntegrityConfig } from "./src/types";

/**
 * A worked example. Copy it, point it at your own files, delete what you do not need.
 *
 * The engine ships **mechanisms**; the rules are yours and live here. That split is
 * not tidiness — it is what lets this package be public while your invariants stay
 * private. Nothing in `src/` knows what any of these ids mean.
 *
 * Run it:
 *
 *   bun run src/cli.ts --config integrity.config.example.ts --root .
 */

const config: IntegrityConfig = {
  /**
   * Whatever must stay deterministic — a pricing calculation, an authorization
   * decision, a reducer. The check follows every within-project import from the
   * entry point, so a clock reached through three layers of helper still fires.
   */
  purityClosures: [
    {
      id: "decide-stays-pure",
      entryPoints: ["src/decide.ts"],
      forbidden: FORBIDDEN_NONDETERMINISM,
    },
  ],

  /**
   * Properties of a single file that a type system cannot hold: a header that must
   * survive every refactor, a sink that must never appear. Matched over AST nodes, so
   * the doc comment above the code neither satisfies nor trips the rule.
   */
  fileInvariants: [
    {
      id: "render-keeps-its-csp",
      file: "src/render.ts",
      literalsRequired: ["default-src 'none'"],
      literalsForbidden: ["<script"],
      membersForbidden: ["innerHTML"],
    },
  ],

  /**
   * Byte hygiene over whole trees. Include docs and config, not just code: a bidi
   * override in a README is read by humans making decisions, and a NUL anywhere makes
   * the file unreviewable in `git`.
   */
  sourceEncoding: [
    {
      id: "no-invisible-characters",
      roots: ["src", "test"],
      extensions: [".ts", ".tsx", ".json", ".md"],
    },
  ],
};

export default config;
