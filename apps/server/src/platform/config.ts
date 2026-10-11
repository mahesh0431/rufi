import { isAbsolute, resolve } from "node:path";
import { Context } from "effect";

/**
 * The data folder RUFI_HOME names, when it is set and not blank: it picks a
 * folder for demo, tests and restored copies, in place of the remembered
 * one (core/store/data-folder.ts).
 */
export function rufiHomeOverride(env: NodeJS.ProcessEnv): string | undefined {
  const home = env["RUFI_HOME"]?.trim();
  if (!home) return undefined;
  return isAbsolute(home) ? home : resolve(home);
}

/**
 * RUFI_HOME, required: for the scripts that run on the test sign-in only
 * (the live AI set, the reader pack), never on the person's data.
 */
export function rufiHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = rufiHomeOverride(env);
  if (home === undefined) {
    throw new Error(
      "Set RUFI_HOME to Rufi's data folder first, for example: export RUFI_HOME=~/rufi-test",
    );
  }
  return home;
}

/** Rufi's data folder, for the parts that need it. */
export class Home extends Context.Service<Home, string>()("rufi/Home") {}

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
