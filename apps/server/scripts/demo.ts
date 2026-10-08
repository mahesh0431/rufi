// `pnpm demo` (after it builds the screens): resets the demo folder to the
// golden data set, then opens the Rufi app on it, as `pnpm desktop` does.
//
//   pnpm demo
import { spawn } from "node:child_process";
import { join } from "node:path";
import { demoFolder, resetDemo } from "./demo-folder.ts";

const folder = demoFolder();
try {
  await resetDemo(folder, process.env, new Date());
} catch (error) {
  // The message only, as Rufi's commands show a failure.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
console.log(`Rufi's demo folder is reset: ${folder}`);

const child = spawn(
  process.execPath,
  [join(import.meta.dirname, "../../desktop/scripts/desktop.ts")],
  { stdio: "inherit", env: { ...process.env, RUFI_HOME: folder } },
);
// Ctrl-C reaches the app as well, which stops Rufi and quits.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
