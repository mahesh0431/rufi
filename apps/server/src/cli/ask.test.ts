// The terminal ask's real lifecycle, offline: real Codex and MCP tools, with
// a local fake model and a fictional record chosen at the composition root.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { fakeModel, type Step } from "../../tests/fake-model.ts";
import { codexBinary } from "../agent/codex/binary.ts";
import { codexRuntime } from "../agent/codex/codex.ts";
import { forAgent } from "../core/tools/tools.ts";
import { ask } from "./ask.ts";

it("fails a terminal ask when its tool refusal allowance is used, with the caller's reason", async () => {
  const home = await mkdtemp(join(tmpdir(), "rufi-ask-"));
  const log = () => undefined;
  const tools = forAgent(
    () => ({ store: undefined, personId: undefined }),
    log,
  );
  const bad: Step = {
    exec: 'text(await tools.mcp__rufi__get_records({ kind: "not-a-kind" }));',
  };
  const model = await fakeModel({ script: [bad, bad, bad, { text: "Done." }] });
  try {
    const file = await codexBinary();
    const end = await Effect.runPromise(
      Effect.scoped(
        ask("Read the record.", {
          model: "gpt-6.1-sol",
          instructions: tools.instructions,
          tools,
          agent: (host) =>
            codexRuntime({
              home,
              command: {
                file,
                args: [
                  "-c",
                  `model_providers.openai_chatgpt_plan.base_url="${model.url}"`,
                ],
              },
              env: { PATH: process.env["PATH"] ?? "" },
              token: () => Promise.resolve("not-a-real-token"),
              version: "0.0.0",
              host,
              log,
            }),
          onEvent: () => undefined,
          log,
        }),
      ),
    );
    expect(end).toEqual({
      status: "failed",
      text: "The AI kept making requests Rufi couldn't accept.",
    });
  } finally {
    await model.close();
  }
}, 60_000);
