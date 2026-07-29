import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "bun:test";
import { parseServerArgs, serveIntegrity } from "../src/mcp";
import { formatRunResult } from "../src/report";
import type { IntegrityConfig } from "../src/types";

/**
 * The MCP surface must be a TRANSPORT, never a second opinion: it calls the same
 * `run(config, root)` the CLI calls and formats the same result. These tests hold
 * the three properties that make it safe to put in front of an agent —
 *
 *  1. **The caller cannot choose the ruleset or the tree.** Both are pinned at
 *     startup (#143). Measured on the draft that passed them per call: over a tree
 *     holding a NUL byte, an empty config turned `1 FINDING` into `OK — no findings
 *     across 0 check(s)`. Green without touching the judged code.
 *  2. **A failing gate is visibly failing.** `isError` tracks the verdict, not
 *     transport health, so an agent that reads only the success flag still learns
 *     the check failed.
 *  3. **`filesScanned` is always reported.** A check that scanned nothing is not a
 *     check that passed (#132), and an agent reading "OK" alone could not tell.
 */

const NUL = String.fromCharCode(0x00);

/** A ruleset that actually looks for something. */
const STRICT: IntegrityConfig = {
  purityClosures: [],
  sourceEncoding: [{ id: "no-invisible-characters", roots: ["."], extensions: [".ts"] }],
};

/** A ruleset that answers OK to every question — the laundering payload. */
const PERMISSIVE: IntegrityConfig = { purityClosures: [] };

/** A tiny repo whose single source file holds `fileContents`. */
function fixture(fileContents: string): string {
  const root = mkdtempSync(join(tmpdir(), "cg-mcp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), fileContents);
  return root;
}

async function connect(config: IntegrityConfig, root: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serveIntegrity(serverTransport, { config, root });
  const agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(clientTransport);
  return agent;
}

interface ToolReply {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe("claudeguard-integrity MCP server", () => {
  test("advertises exactly one read-only tool, and it takes NO arguments", async () => {
    const agent = await connect(STRICT, fixture("export const x = 1;\n"));
    const { tools } = await agent.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["check_integrity"]);
    expect(tools[0]?.description).toContain("Never edits files");
    // The nullary shape IS the security property — nothing to steer (#143).
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual([]);
    await agent.close();
  });

  test("a clean repo reports OK and names how many files were scanned", async () => {
    const agent = await connect(STRICT, fixture("export const x = 1;\n"));

    const result = (await agent.callTool({ name: "check_integrity" })) as ToolReply;

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("OK — no findings");
    // The non-inert proof travels with the verdict (#132).
    expect(result.content[0]?.text).toMatch(/file\(s\) scanned/);
    await agent.close();
  });

  test("A FAILING GATE IS FLAGGED AS AN ERROR, not quietly reported as text", async () => {
    const agent = await connect(STRICT, fixture(`const key = \`\${a}${NUL}\${b}\`;\n`));

    const result = (await agent.callTool({ name: "check_integrity" })) as ToolReply;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("FINDING(S)");
    expect(result.content[0]?.text).toContain("U+0000");
    await agent.close();
  });

  test("A CALLER CANNOT SUBSTITUTE A LENIENT RULESET to launder a green verdict", async () => {
    const dirty = fixture(`const key = \`\${a}${NUL}\${b}\`;\n`);
    const clean = fixture("export const x = 1;\n");
    const agent = await connect(STRICT, dirty);

    // The exact reproduction of the defect #143 closed: hand the tool a permissive
    // ruleset and a clean tree, and see whether the verdict moves.
    const steered = (await agent.callTool({
      name: "check_integrity",
      arguments: { config: PERMISSIVE, root: clean },
    })) as ToolReply;

    expect(steered.isError).toBe(true);
    expect(steered.content[0]?.text).toContain("takes no arguments");
    // Refused, not silently honoured — and never a green verdict.
    expect(steered.content[0]?.text).not.toContain("OK — no findings");

    // The pinned ruleset still decides, unchanged by the attempt.
    const pinned = (await agent.callTool({ name: "check_integrity" })) as ToolReply;
    expect(pinned.isError).toBe(true);
    expect(pinned.content[0]?.text).toContain("U+0000");
    await agent.close();
  });

  test("a ruleset that declares NO checks is refused at startup, not served", async () => {
    const [, serverTransport] = InMemoryTransport.createLinkedPair();

    // 0 checks would answer OK to every question, which reads exactly like a clean
    // tree. Unreachable through the surface beats unlikely (#132).
    let refusal: unknown;
    try {
      await serveIntegrity(serverTransport, { config: PERMISSIVE, root: fixture("") });
    } catch (caught) {
      refusal = caught;
    }

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("declares 0 checks");
  });

  test("an unknown tool is refused", async () => {
    const agent = await connect(STRICT, fixture("export const x = 1;\n"));
    const result = (await agent.callTool({ name: "fix_integrity" })) as ToolReply;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unknown tool");
    await agent.close();
  });
});

describe("parseServerArgs — the pin is set once, at startup", () => {
  test("--config is required and its absence is loud", () => {
    expect(() => parseServerArgs([])).toThrow(/--config is required/);
  });

  test("--config and --root are resolved to absolute paths", () => {
    const args = parseServerArgs(["--config", "cfg.ts", "--root", "."]);
    expect(args.configPath).toContain("cfg.ts");
    expect(args.root.length).toBeGreaterThan(1);
  });
});

describe("formatRunResult — the CLI and the MCP surface say the same thing", () => {
  test("a clean run still reports per-check scan counts", () => {
    const text = formatRunResult({
      results: [{ checkId: "a", findings: [], filesScanned: 12 }],
      findings: [],
      ok: true,
    });
    expect(text).toContain("OK — no findings across 1 check(s).");
    expect(text).toContain("a: 12 file(s) scanned, 0 finding(s)");
  });

  test("findings are listed with file, line, check and token", () => {
    const finding = {
      checkId: "no-invisible-characters",
      file: "src/a.ts",
      line: 3,
      token: "U+0000",
      message: "control character",
    };
    const text = formatRunResult({
      results: [{ checkId: finding.checkId, findings: [finding], filesScanned: 1 }],
      findings: [finding],
      ok: false,
    });
    expect(text).toContain("1 FINDING(S):");
    expect(text).toContain("src/a.ts:3 [no-invisible-characters] U+0000 — control character");
  });
});
