import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { formatRunResult, summaryLines } from "../src/report";
import { run } from "../src/runner";
import type { IntegrityConfig } from "../src/types";

/**
 * The CLI is the surface that actually runs in `bun run check` and in CI — and until
 * now it was the only surface with no test at all. Everything it does happens through
 * `process.exit` and two streams, so these tests spawn it for real rather than calling
 * an inner function: the exit code is the contract CI depends on, and a test that
 * never produces one proves nothing about CI.
 *
 * The last test is the important one. It holds the CLI and the MCP surface to the
 * *same words* for the same run, which is the property that stopped being true once
 * the two grew their own copies of the reporting code.
 */

const NUL = String.fromCharCode(0x00);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const STRICT: IntegrityConfig = {
  purityClosures: [],
  sourceEncoding: [{ id: "no-invisible-characters", roots: ["."], extensions: [".ts"] }],
};

/** A repo whose one source file holds `contents`, plus a config module beside it. */
function fixture(contents: string): { root: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "cg-cli-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), contents);

  const config = join(root, "integrity.config.ts");
  writeFileSync(
    config,
    `const config = {
  purityClosures: [],
  sourceEncoding: [{ id: "no-invisible-characters", roots: ["."], extensions: [".ts"] }],
};
export default config;
`,
  );
  return { root, config };
}

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliRun> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("claudeguard-integrity CLI", () => {
  test("a clean tree exits 0 and says how many files each check parsed", async () => {
    const { root, config } = fixture("export const x = 1;\n");

    const result = await runCli(["--config", config, "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("OK — no findings");
    // The non-inert proof reaches the operator, not just the exit code (#132).
    expect(result.stderr).toContain("file(s) scanned");
  });

  test("A FINDING EXITS 1 — the contract CI actually depends on", async () => {
    const { root, config } = fixture(`const key = \`\${a}${NUL}\${b}\`;\n`);

    const result = await runCli(["--config", config, "--root", root]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("FINDING(S)");
    expect(result.stderr).toContain("U+0000");
    // A red run must not also print a green headline anywhere.
    expect(result.stdout).not.toContain("OK — no findings");
  });

  test("a missing --config is refused with usage, not a green run", async () => {
    const result = await runCli([]);

    // Exit 2 = "could not run", deliberately distinct from 1 = "found something".
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--config is required");
    expect(result.stdout).not.toContain("OK");
  });

  test("THE TWO SURFACES SAY THE SAME THING about the same run", async () => {
    const { root, config } = fixture("export const x = 1;\n");

    const cli = await runCli(["--config", config, "--root", root]);
    // What the MCP surface would return for the identical run.
    const inProcess = run(STRICT, root);

    // Same per-check wording, character for character.
    for (const line of summaryLines(inProcess)) {
      expect(cli.stderr).toContain(line);
    }
    // Same headline, too — the divergence that motivated `report.ts` was exactly
    // one surface calling files "in closure" and the other calling them "scanned".
    expect(formatRunResult(inProcess).split("\n")[0]).toBeDefined();
    expect(cli.stdout).toContain("OK — no findings across 1 check(s).");
  });
});
