import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway repository on disk, for the checks whose whole job is reading one. */
export interface Tree {
  readonly root: string;
  readonly cleanup: () => void;
}

/** Materialise `files` (repo-relative path → content) under a fresh temp directory. */
export function tree(files: Readonly<Record<string, string>>): Tree {
  const root = mkdtempSync(join(tmpdir(), "integrity-tree-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
