import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_BINARY_EXTENSIONS,
  DEFAULT_DATA_EXTENSIONS,
  DEFAULT_EXCLUDED_DIRS,
  type CheckResult,
  type Finding,
  type SourceEncodingRule,
} from "../types";

/**
 * Check #3 — `source-encoding`: no file may carry a character that a human reviewer
 * cannot see but a machine acts on.
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
 * The check has been hardened twice, and both times the hole was not a missing item
 * in a list — it was the existence of the list.
 *
 * **1. Coverage is DERIVED, not enumerated (decision #181).** Measured against the
 * runtime's own Unicode tables, the hand-written block list missed **3802** code
 * points that Unicode marks invisible: the reserved tail of the Tags plane
 * (U+E0080–E0FFF), fourteen variation selectors (U+FE00–FE0D), U+061C (a bidi mark
 * of the same class as the U+200E/200F the list did hold), the above-BMP format
 * controls at U+1D173–1D17A and U+13430–1343F. So coverage now comes from
 * {@link UNICODE_INVISIBLE} — the control, format and separator categories plus
 * `Default_Ignorable_Code_Point`, the property that means "a renderer draws nothing
 * here". The named families below exist only to make a finding NAME the real threat;
 * none is load-bearing for coverage, and a test walks the whole code-point space to
 * prove no family can claim a character the property gate would let through.
 *
 * **2. The FILE SET is accounted for, not opted into (decision #182).** The check
 * used to read only configured extensions. Measured on the host repo, that left
 * **144 of 532 tracked files unread — eleven of them executable**: the git hooks that
 * run on every push, the Dockerfile, the `examples/hardware-signing/*.sh` scripts a
 * user is told to run against their HSM, and `scripts/test-rules.sh`, the runner of
 * this very gate. A Trojan Source line in any of them was invisible to the tool whose
 * entire job is to see it. None of those files was actually dirty — but blindness is
 * not cleanliness, and an opt-in list is a place to hide.
 *
 * So the rule now reads EVERY file under its roots, and the only reasons it may
 * decline are declared, bounded and **counted in the report**:
 *
 *  - a declared binary extension ({@link DEFAULT_BINARY_EXTENSIONS}) — an UNdeclared
 *    binary is read and fails loudly, because that is where a payload would sit;
 *  - an excluded directory name, each one reported by path, because `DEFAULT_EXCLUDED_DIRS`
 *    matches by name at any depth and a source directory called `build` would
 *    otherwise go unread in silence;
 *  - a symlink, which is reported rather than followed: a file whose real content
 *    lives somewhere else is an indirection a reviewer did not consent to.
 *
 * **Invalid UTF-8 is a finding, not a pass.** `readFileSync(…, "utf8")` silently
 * replaces malformed bytes with U+FFFD, which is a perfectly visible character — so
 * an overlong encoding or a lone surrogate used to slip through a scan that only
 * looked at decoded text. Every file is now compared byte-for-byte against a
 * re-encode of its own decoding, and a mismatch is reported.
 *
 * **Allowances are bounded by construction.** A rule may tolerate extra code points
 * per extension (prose hyphenates; code does not), but never one claimed by a hard
 * family — controls, bidi controls, line separators, tag characters, variation
 * selectors. A config that asks for one gets a finding, not an exception. The escape
 * hatch cannot be widened into a door.
 *
 * **Attack fixtures are data, and data is still read.** A concealment corpus must
 * hold the real bytes or it tests nothing, so `dataPaths` reduces the rule for inert
 * data extensions to "no control characters, valid UTF-8" — a fixture git treats as
 * binary is as unreviewable as any other file. The reduction never applies to a
 * script or source file under those paths.
 *
 * **It fails in the safe direction.** A runtime with newer Unicode tables covers
 * MORE, never less; a coverage-floor test asserts a fixed list of representative code
 * points still fires, so an older table fails the suite instead of quietly narrowing
 * the gate.
 *
 * **Measured, not asserted.** Before shipping: 0 findings over the host tree's 532
 * tracked files and 0 over the engine's own repo, with 5 corpus fixtures reading as
 * data; no finding on Czech diacritics, non-breaking space, em dash or above-BMP
 * emoji; and the enumerated predecessor measured as missing 3802 code points.
 *
 * This file deliberately spells every forbidden code point NUMERICALLY — it must
 * contain none of the characters it forbids, and because the check runs over its
 * own directory, that property is self-enforcing.
 */

/**
 * The coverage authority: every code point Unicode itself treats as invisible.
 *
 *  - `\p{Cc}` — C0 and C1 controls, the git-blinding family (tab/LF/CR are allowed
 *    back in below). A C1 byte decoded from UTF-8 can only have been written
 *    deliberately, since no editor emits one.
 *  - `\p{Cf}` — format characters: bidi controls, zero-width, word joiner and its
 *    invisible-operator neighbours (U+2061–2064), interlinear annotation, Tags.
 *  - `\p{Zl}` / `\p{Zp}` — U+2028/2029, line breaks most review tooling does not
 *    render as line breaks.
 *  - `Default_Ignorable_Code_Point` — what the categories miss because the character
 *    is nominally a letter or a mark: Hangul fillers, variation selectors, and the
 *    unassigned-but-ignorable tails of the Tags and variation-selector planes.
 */
const UNICODE_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * The only invisibles any file may hold unconditionally. Tab, LF and CR are visible
 * in a diff; U+FE0E/U+FE0F are the text and emoji presentation selectors, without
 * which the gate cries over every emoji in a README and gets switched off. That
 * argument covers exactly those two — the other fourteen selectors (U+FE00–FE0D) are
 * a documented smuggling alphabet, one byte per selector, and are refused.
 */
const ALWAYS_ALLOWED: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d, 0xfe0e, 0xfe0f]);

/**
 * One family of forbidden code points, with the reason a finding cites. These
 * classify for the REPORT; {@link UNICODE_INVISIBLE} decides coverage.
 */
interface ForbiddenClass {
  readonly name: string;
  readonly why: string;
  readonly holds: (code: number) => boolean;
}

const CONTROL: ForbiddenClass = {
  name: "control character",
  why: "git classifies a file holding it as binary — no reviewable diff, no blame, so every later change to this file ships unreviewed",
  holds: (code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f),
};

const BIDI: ForbiddenClass = {
  name: "bidirectional control",
  why: "Trojan Source (CVE-2021-42574) — the code a reviewer reads is not the code that compiles",
  holds: (code) =>
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c,
};

const LINE_SEPARATOR: ForbiddenClass = {
  name: "invisible line separator",
  why: "U+2028/2029 end a line for the parser but not for the diff — a statement can hide on a line a reviewer never sees",
  holds: (code) => code === 0x2028 || code === 0x2029,
};

// Above the BMP except for the variation-selector base block, so these only ever
// match when the scan reads whole code points; see the code-point loop in scanText.
const SMUGGLED: ForbiddenClass = {
  name: "tag character or variation selector",
  why: "the ASCII-smuggling / invisible-prompt-injection alphabet — renders blank, carries a full instruction to a machine",
  holds: (code) => (code >= 0xe0000 && code <= 0xe0fff) || (code >= 0xfe00 && code <= 0xfe0d),
};

const ZERO_WIDTH: ForbiddenClass = {
  name: "zero-width or invisible formatting character",
  why: "an identifier or literal can be split or spoofed with no visible trace",
  holds: (code) =>
    code === 0x00ad ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200d) ||
    (code >= 0x2060 && code <= 0x2065) ||
    (code >= 0x206a && code <= 0x206f) ||
    code === 0x3164 ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff9 && code <= 0xfffb),
};

/**
 * The backstop. Reached only for a code point {@link UNICODE_INVISIBLE} matched and
 * no named family claimed — a format or default-ignorable character the families
 * have no specific story about. It reports rather than passes: an unnamed invisible
 * is still an invisible.
 */
const DEFAULT_IGNORABLE: ForbiddenClass = {
  name: "Unicode default-ignorable character",
  why: "Unicode marks it as drawing nothing — invisible to the reviewer, still text to the machine",
  holds: () => true,
};

/** Named families, most specific first; the backstop is applied separately. */
const NAMED_CLASSES: readonly ForbiddenClass[] = [
  CONTROL,
  BIDI,
  LINE_SEPARATOR,
  SMUGGLED,
  ZERO_WIDTH,
];

/**
 * Families no config may ever be granted an exception to. A soft hyphen is
 * typography; a bidi override, a tag character or a NUL is not, at any extension, in
 * any file type. Keeping this list separate from {@link NAMED_CLASSES} is what makes
 * the allowance mechanism bounded rather than merely discouraged.
 */
const UNALLOWABLE_CLASSES: readonly ForbiddenClass[] = [CONTROL, BIDI, LINE_SEPARATOR, SMUGGLED];

/**
 * Findings reported per file before the scan of that file stops. A file that is
 * genuinely binary would otherwise emit thousands of identical findings; the fix is
 * per FILE, so ten locations are already more than an operator needs.
 */
const MAX_FINDINGS_PER_FILE = 10;

/**
 * Classification memo, keyed by code point. Deterministic (a pure function of the
 * code point) and bounded by the distinct characters present in the scanned tree — it
 * exists so the property test runs once per DISTINCT character rather than once per
 * byte of prose. Allowances are applied by the CALLER, never folded in here: a memo
 * that remembered one rule's allowance would leak it into the next rule.
 */
const classified = new Map<number, ForbiddenClass | null>();

/** The forbidden family for `code`, or `null` when the character is visible. */
function classify(code: number): ForbiddenClass | null {
  const memo = classified.get(code);
  if (memo !== undefined) return memo;
  const result = UNICODE_INVISIBLE.test(String.fromCodePoint(code))
    ? (NAMED_CLASSES.find((klass) => klass.holds(code)) ?? DEFAULT_IGNORABLE)
    : null;
  classified.set(code, result);
  return result;
}

/** `U+0000`-style name — the only way to write these characters in a report. */
function codePointName(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Repo-relative, forward-slashed — the form every finding and report uses. */
function relative(root: string, absolute: string): string {
  return absolute
    .slice(root.length + 1)
    .split("\\")
    .join("/");
}

/** Lower-cased extension including the dot, or `""` for a file without one. */
function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** What a walk found, including everything it declined to read and why. */
interface Walked {
  readonly files: string[];
  readonly symlinks: string[];
  readonly binarySkipped: string[];
  readonly dirsSkipped: string[];
}

/**
 * Every file under `dir`, depth-first and sorted (deterministic), together with what
 * was skipped. Nothing is dropped quietly: a skipped directory, a skipped binary and
 * a symlink each come back so the caller can report them.
 */
function walk(
  dir: string,
  root: string,
  excluded: ReadonlySet<string>,
  binary: ReadonlySet<string>,
): Walked {
  const files: string[] = [];
  const symlinks: string[] = [];
  const binarySkipped: string[] = [];
  const dirsSkipped: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) {
        dirsSkipped.push(relative(root, full));
        continue;
      }
      const inner = walk(full, root, excluded, binary);
      files.push(...inner.files);
      symlinks.push(...inner.symlinks);
      binarySkipped.push(...inner.binarySkipped);
      dirsSkipped.push(...inner.dirsSkipped);
    } else if (entry.isSymbolicLink()) {
      // Not followed: the bytes a reviewer reads would come from somewhere the diff
      // never showed them, and following one can also leave the root entirely.
      symlinks.push(relative(root, full));
    } else if (entry.isFile()) {
      if (binary.has(extensionOf(entry.name))) {
        binarySkipped.push(relative(root, full));
      } else {
        files.push(full);
      }
    }
  }
  return { files, symlinks, binarySkipped, dirsSkipped };
}

/** Scan decoded text by code point, reporting each forbidden one with its line. */
function scanText(
  text: string,
  relativePath: string,
  checkId: string,
  allowed: ReadonlySet<number>,
  dataOnly: boolean,
): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  // Iterate by CODE POINT, not UTF-16 code unit: the Tags block and the
  // variation-selector supplement live above the BMP (each code point is a surrogate
  // pair), so a code-unit scan would only ever see surrogate halves, never U+E00xx.
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index)!;
    if (code === 0x0a) {
      line += 1;
      index += 1;
      continue;
    }
    // Fast path: printable ASCII is never invisible, and it is almost all of source.
    if (code >= 0x20 && code <= 0x7e) {
      index += 1;
      continue;
    }
    const offending = allowed.has(code) ? null : classify(code);
    // Data fixtures carry the concealment alphabet on purpose; what they may NOT carry
    // is a control character, which would make git treat the fixture as binary.
    const reportable = offending !== null && (!dataOnly || offending === CONTROL);
    if (reportable) {
      findings.push({
        checkId,
        file: relativePath,
        line,
        token: codePointName(code),
        message: `${offending.name} ${codePointName(code)} in source — ${offending.why}`,
      });
      if (findings.length >= MAX_FINDINGS_PER_FILE) break;
    }
    index += code > 0xffff ? 2 : 1;
  }
  return findings;
}

/**
 * Read one file and scan it. Decoding is verified against the raw bytes first: a
 * malformed sequence decodes to U+FFFD, which no invisible-character rule would ever
 * flag, so a scan that trusted the decode could be walked straight past.
 */
function scanFile(
  absolute: string,
  relativePath: string,
  checkId: string,
  allowed: ReadonlySet<number>,
  dataOnly: boolean,
): Finding[] {
  const raw = readFileSync(absolute);
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    return [
      {
        checkId,
        file: relativePath,
        line: 1,
        token: "invalid UTF-8",
        message:
          "invalid UTF-8 — the bytes do not survive a decode/encode round trip, so what a reviewer sees is a substitution character and what a consumer gets is up to its decoder",
      },
    ];
  }
  return scanText(text, relativePath, checkId, allowed, dataOnly);
}

/**
 * Validate the rule's allowances and build the per-extension allow sets. An allowance
 * for a hard-family code point is refused AS A FINDING: it is a config trying to
 * legalise a NUL or a bidi override, and answering that with silence would make the
 * mechanism the hole.
 */
function resolveAllowances(rule: SourceEncodingRule): {
  readonly byExtension: ReadonlyMap<string, ReadonlySet<number>>;
  readonly findings: Finding[];
} {
  const byExtension = new Map<string, ReadonlySet<number>>();
  const findings: Finding[] = [];
  for (const [extension, codes] of Object.entries(rule.allowancesByExtension ?? {})) {
    const accepted = new Set<number>(ALWAYS_ALLOWED);
    for (const code of codes) {
      const hard = UNALLOWABLE_CLASSES.find((klass) => klass.holds(code));
      if (hard !== undefined) {
        findings.push({
          checkId: rule.id,
          file: "integrity config",
          line: 1,
          token: codePointName(code),
          message: `config allows ${codePointName(code)} for '${extension}', but a ${hard.name} is never legitimate in an authored file — the allowance is refused, not applied`,
        });
        continue;
      }
      accepted.add(code);
    }
    byExtension.set(extension.toLowerCase(), accepted);
  }
  return { byExtension, findings };
}

/**
 * Run one source-encoding rule against a repo root. A configured root that does not
 * exist is a FINDING, not a skip — the same fail-loud rule the file-invariants check
 * follows: a gate that silently stops checking is worse than no gate, because it
 * reports green for the very reason it went blind. Every other way of not reading a
 * file is reported the same way, by count.
 */
export function runSourceEncoding(root: string, rule: SourceEncodingRule): CheckResult {
  const excluded = new Set(rule.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
  const binary = new Set(
    (rule.binaryExtensions ?? DEFAULT_BINARY_EXTENSIONS).map((extension) =>
      extension.toLowerCase(),
    ),
  );
  const dataPaths = rule.dataPaths ?? [];
  const allowances = resolveAllowances(rule);
  const findings: Finding[] = [...allowances.findings];
  const skipped: { reason: string; count: number }[] = [];
  let filesScanned = 0;
  let dataScanned = 0;
  let unreadByExtensionFilter = 0;
  let symlinks = 0;
  let binarySkipped = 0;
  let dirsSkipped = 0;

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
    const walked = walk(absoluteRoot, root, excluded, binary);
    binarySkipped += walked.binarySkipped.length;
    dirsSkipped += walked.dirsSkipped.length;
    symlinks += walked.symlinks.length;
    for (const path of walked.symlinks) {
      findings.push({
        checkId: rule.id,
        file: path,
        line: 1,
        token: "symlink",
        message:
          "symlink in a scanned tree — its real bytes live outside this path, so the gate refuses to read it on the reviewer's behalf; replace it with the file or exclude its directory explicitly",
      });
    }
    for (const absolute of walked.files) {
      const relativePath = relative(root, absolute);
      const extension = extensionOf(relativePath);
      // A narrowed scan stays possible for compatibility, but it cannot be quiet.
      if (rule.extensions !== undefined && !rule.extensions.some((e) => relativePath.endsWith(e))) {
        unreadByExtensionFilter += 1;
        continue;
      }
      const isData =
        DEFAULT_DATA_EXTENSIONS.includes(extension) &&
        dataPaths.some((prefix) => relativePath.startsWith(prefix));
      const allowed = allowances.byExtension.get(extension) ?? ALWAYS_ALLOWED;
      filesScanned += 1;
      if (isData) dataScanned += 1;
      findings.push(...scanFile(absolute, relativePath, rule.id, allowed, isData));
    }
  }

  if (unreadByExtensionFilter > 0) {
    findings.push({
      checkId: rule.id,
      file: "integrity config",
      line: 1,
      token: "extensions",
      message: `rule declares a deprecated 'extensions' allow-list and therefore left ${String(unreadByExtensionFilter)} readable file(s) unread — an opt-in list is a place to hide; remove it and declare binary extensions instead`,
    });
    skipped.push({
      reason: "not in the deprecated 'extensions' list",
      count: unreadByExtensionFilter,
    });
  }
  if (binarySkipped > 0)
    skipped.push({ reason: "declared binary extension", count: binarySkipped });
  if (dirsSkipped > 0) skipped.push({ reason: "excluded directory", count: dirsSkipped });
  if (symlinks > 0) skipped.push({ reason: "symlink (reported, not followed)", count: symlinks });
  if (dataScanned > 0) {
    skipped.push({
      reason: "read as declared attack/trace data (reduced rule)",
      count: dataScanned,
    });
  }

  return { checkId: rule.id, findings, filesScanned, skipped };
}

/**
 * Exported for the coverage-floor and family-consistency tests, which are the only
 * reason these are visible: they prove no named family claims a code point
 * {@link UNICODE_INVISIBLE} would let through, and that a fixed list of
 * representative invisibles still fires on this runtime's Unicode tables.
 */
export const INTERNALS = {
  UNICODE_INVISIBLE,
  ALWAYS_ALLOWED,
  NAMED_CLASSES,
  UNALLOWABLE_CLASSES,
} as const;
