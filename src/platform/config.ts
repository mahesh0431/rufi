import { isAbsolute, resolve } from "node:path";

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
