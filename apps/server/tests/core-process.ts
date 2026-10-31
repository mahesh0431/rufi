// The core in a process of its own, on the scripted Codex, for a test that
// kills it as a crash would. Usage: node core-process.ts <data folder>, with
// the scenario in FAKE_CODEX. It runs until it is killed; the test reaches it
// through core.json, as `pnpm start` does.
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { codexAdapter } from "../src/agent/codex/adapter.ts";
import { agentSetup, startCore } from "../src/server/core.ts";
import { codexSignIn } from "../src/server/signin.ts";

const home = process.argv[2] ?? "";
const codex = codexAdapter({
  home,
  ...agentSetup(home),
  command: {
    file: process.execPath,
    args: [join(import.meta.dirname, "fake-codex.ts")],
  },
  env: {
    PATH: process.env["PATH"] ?? "",
    FAKE_CODEX: process.env["FAKE_CODEX"] ?? "{}",
  },
  version: "0.0.0",
});
const scope = await Effect.runPromise(Scope.make());
await Effect.runPromise(
  startCore({
    home,
    adapters: [codex],
    log: () => undefined,
    signIns: { codex: codexSignIn(codex, () => undefined) },
  }).pipe(Scope.provide(scope)),
);
