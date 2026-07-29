import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatFinding, summaryLines, verdictLine } from "./report";
import { run } from "./runner";
import type { IntegrityConfig } from "./types";

/**
 * CLI surface (build brief §3 / §10 step 6) — for CI and pre-push, where there is
 * no agent in the loop. Exit 0 = clean, exit 1 = at least one finding, exit 2 =
 * could not run. The engine stays generic: a project's rules are injected via
 * `--config` and never baked in (build brief D4).
 *
 *   bun run src/cli.ts --config <your-project>/integrity.config.ts [--root <dir>]
 */

interface Args {
  readonly configPath: string;
  readonly root: string;
}

function parseArgs(argv: readonly string[]): Args {
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
    console.error(
      "usage: claudeguard-integrity --config <config.ts> [--root <repo-root>]\n" +
        "  --config is required (the project's integrity config; injected, never baked in).",
    );
    process.exit(2);
  }
  return { configPath: resolve(configPath), root: resolve(root) };
}

async function loadConfig(configPath: string): Promise<IntegrityConfig> {
  const module = (await import(pathToFileURL(configPath).href)) as {
    default?: IntegrityConfig;
  };
  if (module.default === undefined) {
    throw new Error(`config "${configPath}" has no default export`);
  }
  return module.default;
}

async function main(): Promise<void> {
  const { configPath, root } = parseArgs(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const result = run(config, root);

  // Per-check summary — the non-inert proof (how many files each check parsed).
  // Wording comes from `report.ts` so this surface cannot drift from the MCP one.
  for (const line of summaryLines(result)) {
    console.error(`  ${line}`);
  }

  if (result.ok) {
    console.log(`claudeguard-integrity: ${verdictLine(result)}`);
    process.exit(0);
  }

  console.error(`\nclaudeguard-integrity: ${verdictLine(result)}\n`);
  for (const finding of result.findings) {
    console.error(`  ${formatFinding(finding)}`);
  }
  process.exit(1);
}

void main();
