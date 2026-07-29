import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_EXCLUDED_DIRS,
  type CheckResult,
  type Finding,
  type SourceEncodingRule,
} from "../types";

/**
 * Check #3 — `source-encoding`: no source file may carry a character that a human
 * reviewer cannot see but a machine acts on.
 *
 * **Why this check is byte-level and not AST-based.** It exists because of a defect
 * that survived every other gate in this repo: a raw NUL byte inside a template
 * literal. It parsed, type-checked, formatted, passed 1338 tests and passed the
 * LLM diff gate — because all of those read the file as text and a NUL is legal
 * text. What it did do was make `git` classify the file as BINARY, so the file had
 * no reviewable diff and no `git blame`. A source file nobody can review is a
 * security liability in its own right, and the tool chain reported green the whole
 * time. Only a byte scan sees this; by the time an AST exists, the byte is inside
 * a token.
 *
 * **The class, not the instance.** Three families are forbidden, all of them
 * "invisible to the reader, meaningful to the machine":
 *
 *  - **C0 controls** (incl. NUL) — the git-blinding family above.
 *  - **Bidi overrides / isolates** — Trojan Source (CVE-2021-42574): the code a
 *    reviewer reads is not the code the compiler sees.
 *  - **Zero-width and BOM** — an identifier or literal split or spoofed invisibly.
 *
 * The last two are the same concealment class that input-scanning security tools
 * look for in untrusted text. Holding them over our own tree closes the asymmetry:
 * a tool that finds concealed characters in someone else's input has no business
 * being blind to them in its own source, where the payoff is higher.
 *
 * **Zero-FP by construction:** tab, newline and carriage return are explicitly
 * allowed, and only configured extensions under configured roots are read. Measured
 * against this repo at the time of writing: 0 findings on a clean tree, 2 findings
 * on the commit that carried the defect.
 *
 * This file deliberately spells every forbidden code point NUMERICALLY — it must
 * contain none of the characters it forbids, and because the check runs over its
 * own directory, that property is self-enforcing.
 */

/** One family of forbidden code points, with the reason a finding cites. */
interface ForbiddenClass {
  readonly name: string;
  readonly why: string;
  readonly holds: (code: number) => boolean;
}

/** Tab (0x09), LF (0x0A) and CR (0x0D) are the only control characters source may hold. */
const CONTROL: ForbiddenClass = {
  name: "control character",
  why: "git classifies a file holding it as binary — no reviewable diff, no blame, so every later change to this file ships unreviewed",
  holds: (code) =>
    (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f,
};

const BIDI: ForbiddenClass = {
  name: "bidirectional override",
  why: "Trojan Source (CVE-2021-42574) — the code a reviewer reads is not the code that compiles",
  holds: (code) => (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069),
};

const INVISIBLE: ForbiddenClass = {
  name: "zero-width or byte-order mark",
  why: "an identifier or literal can be split or spoofed with no visible trace",
  holds: (code) => code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff,
};

const FORBIDDEN_CLASSES: readonly ForbiddenClass[] = [CONTROL, BIDI, INVISIBLE];

/**
 * Findings reported per file before the scan of that file stops. A file that is
 * genuinely binary would otherwise emit thousands of identical findings; the fix is
 * per FILE, so ten locations are already more than an operator needs.
 */
const MAX_FINDINGS_PER_FILE = 10;

/** `U+0000`-style name — the only way to write these characters in a report. */
function codePointName(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every file under `dir` whose extension matches, depth-first and sorted (deterministic). */
function walk(dir: string, rule: SourceEncodingRule, excluded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) continue;
      out.push(...walk(full, rule, excluded));
    } else if (entry.isFile() && rule.extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** Scan one file's characters, reporting each forbidden code point with its line. */
function scanFile(absolute: string, relativePath: string, checkId: string): Finding[] {
  const findings: Finding[] = [];
  const text = readFileSync(absolute, "utf8");
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      line += 1;
      continue;
    }
    const offending = FORBIDDEN_CLASSES.find((klass) => klass.holds(code));
    if (offending === undefined) continue;
    findings.push({
      checkId,
      file: relativePath,
      line,
      token: codePointName(code),
      message: `${offending.name} ${codePointName(code)} in source — ${offending.why}`,
    });
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
  }
  return findings;
}

/**
 * Run one source-encoding rule against a repo root. A configured root that does not
 * exist is a FINDING, not a skip — the same fail-loud rule the file-invariants check
 * follows: a gate that silently stops checking is worse than no gate, because it
 * reports green for the very reason it went blind.
 */
export function runSourceEncoding(root: string, rule: SourceEncodingRule): CheckResult {
  const excluded = new Set(rule.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const findings: Finding[] = [];
  let filesScanned = 0;

  for (const configuredRoot of rule.roots) {
    const absoluteRoot = resolve(root, configuredRoot);
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      findings.push({
        checkId: rule.id,
        file: configuredRoot,
        line: 1,
        token: configuredRoot,
        message: `configured root '${configuredRoot}' does not exist — the rule would check nothing, which is not the same as passing`,
      });
      continue;
    }
    for (const absolute of walk(absoluteRoot, rule, excluded)) {
      filesScanned += 1;
      const relativePath = absolute
        .slice(root.length + 1)
        .split("\\")
        .join("/");
      findings.push(...scanFile(absolute, relativePath, rule.id));
    }
  }

  return { checkId: rule.id, findings, filesScanned };
}
