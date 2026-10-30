// The terminal ask's real lifecycle, offline: real Codex and MCP tools, with
// a local fake model and a fictional record chosen at the composition root.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { fakeModel } from "../../tests/fake-model.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import { coreInstructions } from "../core/chat/instructions.ts";
import { forAgent } from "../core/tools/tools.ts";
import { agentSetup } from "../server/core.ts";
import { ask } from "./ask.ts";

it("answers a terminal ask once when the sign-in renews before its first turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "rufi-ask-renewal-"));
  const log = () => undefined;
  const tools = forAgent(
    () => ({ store: undefined, personId: undefined }),
    log,
  );
  const model = await fakeModel();
  let text = "";
  let started = 0;
  let messages = 0;
  let tokenCalls = 0;
  try {
    const file = await codexBinary();
    const end = await Effect.runPromise(
      Effect.scoped(
        ask("Hello", {
          model: "gpt-6.1-sol",
          instructions: coreInstructions(undefined),
          tools,
          agent: (host) =>
            codexRuntime({
              home,
              ...agentSetup(home),
              command: {
                file,
                args: [
                  "-c",
                  `model_providers.openai_chatgpt_plan.base_url="${model.url}"`,
                ],
              },
              env: { PATH: process.env["PATH"] ?? "" },
              token: () =>
                Promise.resolve(++tokenCalls === 1 ? "token" : "renewed-token"),
              version: "0.0.0",
              host,
              log,
            }),
          onEvent: (event) => {
            if (event.type === "text") text += event.delta;
            if (event.type === "turnStarted") started++;
            if (event.type === "message") messages++;
          },
          log,
        }),
      ),
    );
    expect(end).toEqual({ status: "completed" });
    expect(text).toBe("ok:Hello");
    expect([started, messages, model.requests.length]).toEqual([1, 1, 1]);
  } finally {
    await model.close();
  }
}, 60_000);
