import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { formatRunResult } from "./report";
import { buildChecks, run } from "./runner";
import type { IntegrityConfig } from "./types";

/**
 * MCP surface (decision #143, completing the shape locked in #126: MCP server +
 * CLI + skill). The CLI is for CI and pre-push, where there is no agent; this is
 * for the agent mid-session — "did what I just wrote break an invariant?" —
 * without shelling out and parsing console output.
 *
 * **The engine is unchanged and remains the only source of truth.** This file is a
 * transport, exactly as `cli.ts` is: both call `run(config, root)` and render it
 * through the same `report.ts`. A second surface must never become a second opinion.
 *
 * **The tool takes no arguments, and that is the security property** (decision
 * #143). Both the ruleset and the tree are pinned when the server starts, from
 * `--config` / `--root`, so the caller chooses neither. An earlier draft passed
 * them per call; measured against a tree holding a NUL byte, substituting an empty
 * config turned `1 FINDING` into `OK — no findings across 0 check(s)`. A caller who
 * can choose the rules can mint a green verdict without touching the code being
 * judged, which is the same silent-green class as #132 — and it needed no hostile
 * file, only a lenient one. Pinning is what makes the answer mean something.
 *
 * **Read-only by construction.** The tool reads source files and returns findings.
 * It cannot edit, stage, or commit — there is deliberately no write path, because a
 * gate that can fix what it judges is no longer a gate. Fixing is the caller's job.
 *
 * **Deterministic.** No clock, no network, no model. The same tree and config give
 * the same findings, which is the whole reason this sits beside an LLM reviewer
 * rather than inside one.
 */

/** What the operator pins when starting the server. Never caller-supplied. */
export interface ServeOptions {
  /** The project's ruleset, already loaded. */
  readonly config: IntegrityConfig;
  /** Absolute path of the tree to check. */
  readonly root: string;
}

/**
 * Deliberately empty: the tool is nullary. Every input a caller could supply is an
 * input that could steer the verdict, so there is nothing to accept.
 */
const CHECK_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** Load a project's config module. Same loader semantics as the CLI, deliberately. */
async function loadConfig(configPath: string): Promise<IntegrityConfig> {
  const module = (await import(pathToFileURL(configPath).href)) as {
    default?: IntegrityConfig;
  };
  if (module.default === undefined) {
    throw new Error(`config "${configPath}" has no default export`);
  }
  return module.default;
}

// Rendering lives in `report.ts`, shared with the CLI: one `RunResult` must not get
// two descriptions depending on which door the reader came through.

/**
 * Bind the engine to an MCP {@link Server} and serve it over `transport`. Tools-only.
 *
 * @throws if `options.config` declares no checks at all. A ruleset with nothing in
 * it answers "OK" to every question, which reads exactly like a clean tree — the
 * failure mode #132 was written about. Refusing at startup keeps that impossible to
 * reach through the surface rather than merely unlikely.
 */
export async function serveIntegrity(transport: Transport, options: ServeOptions): Promise<Server> {
  const checkCount = buildChecks(options.config).length;
  if (checkCount === 0) {
    throw new Error(
      "refusing to serve: the config declares 0 checks, so every run would report OK. " +
        "A gate that checks nothing is not a gate (decision #132).",
    );
  }

  const server = new Server(
    { name: "claudeguard-integrity", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "check_integrity",
        description:
          `Run the deterministic integrity gate over the pinned repository (${options.root}) ` +
          `using the pinned ruleset (${String(checkCount)} check(s)), and return every finding. ` +
          "Takes no arguments: the ruleset and the tree are fixed by the operator at startup, " +
          "so a caller cannot narrow either. Read-only static analysis: AST purity closures, " +
          "file invariants, and a byte-level source-encoding scan. Never edits files.",
        inputSchema: CHECK_INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request): CallToolResult => {
    if (request.params.name !== "check_integrity") {
      return {
        content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    // Refuse rather than ignore. Silently dropping a steering attempt leaves the
    // caller believing it chose the ruleset, which is the misunderstanding the
    // pinning exists to prevent; a refusal makes the attempt visible instead.
    const supplied = Object.keys(request.params.arguments ?? {});
    if (supplied.length > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `check_integrity takes no arguments (received: ${supplied.join(", ")}). ` +
              "The ruleset and the repository root are pinned when the server starts.",
          },
        ],
        isError: true,
      };
    }
    try {
      const result = run(options.config, options.root);
      // `isError` tracks the VERDICT, not transport health: an agent that reads only
      // the success flag must still learn that the gate failed.
      return { content: [{ type: "text", text: formatRunResult(result) }], isError: !result.ok };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `integrity check could not run: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  return server;
}

/** Startup arguments, mirroring the CLI so both surfaces are configured alike. */
export function parseServerArgs(argv: readonly string[]): { configPath: string; root: string } {
  let configPath: string | undefined;
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") {
      configPath = argv[++i];
    } else if (arg === "--root") {
      root = argv[++i] ?? root;
    }
  }
  if (configPath === undefined) {
    throw new Error(
      "usage: claudeguard-integrity-mcp --config <config.ts> [--root <repo-root>]\n" +
        "  --config is required and is pinned for the server's lifetime; the tool takes no arguments.",
    );
  }
  return { configPath: resolve(configPath), root: resolve(root) };
}

/** Entry point: serve over stdio. Only runs when executed directly, never on import. */
if (import.meta.main) {
  const { configPath, root } = parseServerArgs(process.argv.slice(2));
  await serveIntegrity(new StdioServerTransport(), { config: await loadConfig(configPath), root });
}
