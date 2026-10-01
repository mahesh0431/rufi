// The pinned Codex binary from node_modules; never a `codex` found on PATH.
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
};

/** Path to the native binary of the pinned `@openai/codex`, checked before use. */
export async function codexBinary(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const triple = TRIPLES[platform];
  if (!triple) throw new Error(`Codex isn't available for ${platform}.`);
  const require = createRequire(import.meta.url);
  // The platform package is a dependency of @openai/codex, so resolve it from there.
  const codexPackage = require.resolve("@openai/codex/package.json");
  const platformPackage = createRequire(codexPackage).resolve(
    `@openai/codex-${platform}/package.json`,
  );
  const binary = join(
    dirname(platformPackage),
    "vendor",
    triple,
    "bin",
    "codex",
  );
  await checkExecutable(binary);
  return binary;
}

/** Refuses a binary that's missing, not executable, or writable by others. */
export async function checkExecutable(path: string): Promise<void> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (error) {
    throw new Error(`Codex isn't installed at ${path}. Run pnpm install.`, {
      cause: error,
    });
  }
  if ((mode & 0o111) === 0) throw new Error(`${path} isn't executable.`);
  if ((mode & 0o022) !== 0) {
    throw new Error(
      `${path} can be changed by other users, so Rufi won't run it.`,
    );
  }
}
