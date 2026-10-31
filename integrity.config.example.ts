import { FORBIDDEN_NONDETERMINISM, PURE_SURFACE } from "./src/tokens";
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
      // The denylist names the usual suspects by spelling…
      forbidden: FORBIDDEN_NONDETERMINISM,
      // …and the allowlist refuses every other spelling: `globalThis.Date.now()`,
      // `Date["now"]()`, an aliased import of an unlisted module. Add what your closure
      // genuinely needs, one reviewed line at a time.
      allowed: { ...PURE_SURFACE, externalImports: ["zod"] },
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
      // One rule, and NO `extensions` list — it reads every file under the root and
      // reports anything it declined to read. An opt-in list is where a payload hides:
      // measured on the host project, an extension list left 144 of 532 files unread,
      // eleven of them executable (#182).
      id: "no-invisible-characters",
      roots: ["."],
      // A soft hyphen is legitimate typography in prose, and a project whose gate
      // cries over its own README turns the gate off. Code gets no allowance, and the
      // check refuses one for any control, bidi, tag or variation-selector code point.
      allowancesByExtension: { ".md": [0x00ad] },
      // Fixtures whose content IS the attack sample. Still read and counted, under a
      // reduced rule: no control characters, valid UTF-8.
      dataPaths: ["test/fixtures/corpus/"],
    },
  ],
};

export default config;
