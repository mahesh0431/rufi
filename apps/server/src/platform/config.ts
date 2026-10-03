import { isAbsolute, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";

/**
 * Rufi's data folder. Required until dogfood: with no default, nothing can
 * touch the real data folder by accident.
 */
export function rufiHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["RUFI_HOME"]?.trim();
  if (!home) {
    throw new Error(
      "Set RUFI_HOME to Rufi's data folder first, for example: export RUFI_HOME=~/rufi-test",
    );
  }
  return isAbsolute(home) ? home : resolve(home);
}

/** Rufi's data folder, for the parts that need it. */
export class Home extends Context.Service<Home, string>()("rufi/Home") {}

export const homeLayer = Layer.effect(
  Home,
  Effect.try({ try: () => rufiHome(), catch: (error) => error }),
);

/** Variables a child program (Codex) may inherit; secrets like API keys never do. */
const CHILD_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
];

export function childEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of CHILD_VARIABLES) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}
