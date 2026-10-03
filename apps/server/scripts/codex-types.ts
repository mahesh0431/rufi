// Generates the Codex app-server protocol types from the pinned binary into
// src/agent/codex/protocol. CI checks the committed copy matches.
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { codexBinary } from "../src/agent/codex/binary.ts";

export const PROTOCOL_DIR = join(
  import.meta.dirname,
  "../src/agent/codex/protocol",
);

/** Writes the generated types to `outDir`, with `.ts` extensions on relative imports. */
export async function generateProtocol(outDir: string): Promise<void> {
  const raw = await mkdtemp(join(tmpdir(), "rufi-codex-types-"));
  try {
    await promisify(execFile)(
      await codexBinary(),
      ["app-server", "generate-ts", "--experimental", "--out", raw],
      { timeout: 60_000 },
    );
    for (const file of await listFiles(raw)) {
      const text = await readFile(file, "utf8");
      await writeFile(file, await withExtensions(file, text));
    }
    await rm(outDir, { recursive: true, force: true });
    await cp(raw, outDir, { recursive: true });
  } finally {
    await rm(raw, { recursive: true, force: true });
  }
}

/** Every file under `dir`, as paths relative to it, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => (path.startsWith(dir) ? path : relative(dir, path)));
}

async function withExtensions(file: string, text: string): Promise<string> {
  const specifiers = [...text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)];
  let result = text;
  for (const [whole, specifier] of specifiers) {
    if (!specifier || specifier.endsWith(".ts")) continue;
    const target = join(dirname(file), specifier);
    const isDir = await stat(target).then(
      (info) => info.isDirectory(),
      () => false,
    );
    const fixed = isDir ? `${specifier}/index.ts` : `${specifier}.ts`;
    result = result.replace(whole, `from "${fixed}"`);
  }
  return result;
}

if (import.meta.main) {
  await generateProtocol(PROTOCOL_DIR);
  console.log(`Wrote ${PROTOCOL_DIR}`);
}
