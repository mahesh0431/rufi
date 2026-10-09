// Rufi as `pnpm start` runs it, for the screens' tests: the real core with
// the built screens, on a fresh fictional data folder, with the scripted
// Codex instead of the real one, or the real Codex binary on a local fake
// model. Nothing here reaches OpenAI.
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Status } from "@rufi/contracts";
import { test as base } from "@playwright/test";
import { Effect, Exit, Scope } from "effect";
import type { Scenario } from "../../server/tests/fake-codex.ts";
import { fakeModel, type FakeModel } from "../../server/tests/fake-model.ts";
import { FAMILY, FIRST_RUN_DONE } from "../../server/tests/fixtures/golden.ts";
import { codexBinary } from "../../server/src/agent/codex/binary.ts";
import { codexRuntime } from "../../server/src/agent/codex/codex.ts";
import {
  databasePath,
  openWritable,
} from "../../server/src/core/store/database.ts";
import { startCore, type Core } from "../../server/src/server/core.ts";

const SERVER = join(import.meta.dirname, "../../server");
const FAKE = join(SERVER, "tests/fake-codex.ts");
const SCREENS = join(import.meta.dirname, "../dist");

export class Rufi {
  /** What the sign-in status says; tests may change it. */
  account: Status = { account: "signed_in", email: "asha@example.com" };
  /**
   * The sign-ins started from the screens, waiting for ChatGPT's answer;
   * one that succeeds signs Rufi in. No browser opens.
   */
  readonly signIns: PromiseWithResolvers<undefined>[] = [];
  #scope: Scope.Closeable | undefined;
  #core: Core | undefined;
  #model: FakeModel | undefined;

  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /**
   * Adds the fictional family (and any more rows) to the data folder, with
   * the first run done.
   */
  async family(...more: string[]): Promise<void> {
    const store = openWritable(databasePath(this.home));
    try {
      store.db.exec(await readFile(FAMILY, "utf8"));
      store.db.exec(FIRST_RUN_DONE);
      for (const statements of more) store.db.exec(statements);
    } finally {
      store.close();
    }
  }

  /**
   * Starts the core: on `port` to stand in for a restart of the same Rufi;
   * the scripted Codex plays `scenario`; `codex: "real"` runs the real Codex
   * binary on a local fake model instead; `now` is the core's clock, for a
   * test whose page has a fixed clock too.
   */
  async start(
    options: {
      port?: number;
      scenario?: Scenario;
      codex?: "real";
      now?: () => string;
    } = {},
  ): Promise<Core> {
    const { port } = options;
    if (options.codex === "real") this.#model ??= await fakeModel();
    const command =
      options.codex === "real"
        ? {
            file: await codexBinary(),
            args: [
              "-c",
              `model_providers.openai_chatgpt_plan.base_url="${this.#model?.url ?? ""}"`,
            ],
          }
        : { file: process.execPath, args: [FAKE] };
    const scope = await Effect.runPromise(Scope.make());
    this.#scope = scope;
    this.#core = await Effect.runPromise(
      startCore({
        home: this.home,
        agent: (tools, host) =>
          codexRuntime({
            home: this.home,
            command,
            env: {
              PATH: process.env["PATH"] ?? "",
              FAKE_CODEX: JSON.stringify(options.scenario ?? {}),
              FAKE_CODEX_LOG: join(this.home, "fake-codex.jsonl"),
            },
            token: () => Promise.resolve("token"),
            version: "0.0.0",
            tools,
            host,
          }),
        log: () => undefined,
        account: () => Promise.resolve(this.account),
        signIn: async ({ showLink }) => {
          showLink("https://auth.example.com/authorize?fictional=1");
          const run = Promise.withResolvers<undefined>();
          this.signIns.push(run);
          await run.promise;
          this.account = { account: "signed_in", email: "asha@example.com" };
          return { email: "asha@example.com" };
        },
        screens: SCREENS,
        ...(port !== undefined && { port }),
        ...(options.now !== undefined && { now: options.now }),
      }).pipe(Scope.provide(scope)),
    );
    return this.#core;
  }

  get core(): Core {
    if (!this.#core) throw new Error("Rufi isn't running.");
    return this.#core;
  }

  /** A fresh single-use link, as `pnpm start` prints it. */
  link(): string {
    return this.core.launchUrl();
  }

  async stop(): Promise<void> {
    const scope = this.#scope;
    this.#scope = undefined;
    this.#core = undefined;
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
  }

  /** After the last test step: the fake model too. */
  async close(): Promise<void> {
    await this.stop();
    await this.#model?.close();
  }
}

export const test = base.extend<{ rufi: Rufi }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads the fixtures from the pattern
  rufi: async ({}, use) => {
    await access(join(SCREENS, "index.html")).catch((error: unknown) => {
      throw new Error(
        "Build the screens first: pnpm --filter @rufi/web build",
        {
          cause: error,
        },
      );
    });
    const rufi = new Rufi(await mkdtemp(join(tmpdir(), "rufi-screens-")));
    await use(rufi);
    await rufi.close();
    await rm(rufi.home, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";
