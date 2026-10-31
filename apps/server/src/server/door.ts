// Rufi's door for every agent's calls to its tools (docs/adr/0016, 0024).
// Each agent has a key of its own for this run of Rufi, given with its
// conversation each time it opens. A call goes only in the turn the agent's
// adapter places it in, once the package has admitted that turn: a call
// from a turn the provider began by itself waits for it within the call's
// deadline, and anything else is refused, reading tools too. Here, the one
// place, Rufi's id for the call is made (`<agent>/<conversation>/<call>`,
// callIdOf), for every provider. The call then runs with that scope to its
// end, also after the agent stopped waiting for it.
import type { McpRegistration } from "@rufi/agents/provider";
import { callIdOf } from "../core/chat/agents.ts";
import type { CallScope } from "../core/tools/tools.ts";
import type { ToolAnswer, ToolSpec } from "../core/tools/registry.ts";
import type { Log } from "../platform/logs.ts";
import type { McpKeys } from "./mcp.ts";

/** A call placed in its agent's admitted turn, with the provider's id for it. */
export type Placed = Omit<CallScope, "callId"> & { call: string };

export function agentDoor(deps: {
  mcp: { url: () => string; keys: McpKeys };
  /** Every tool Rufi has for agents; an agent sees only its own. */
  specs: readonly ToolSpec[];
  /**
   * The admitted, open turn the call left, with whose the agent is and its
   * tools; nothing when the call can't be placed by the time `signal`
   * aborts.
   */
  place: (
    agent: string,
    meta: unknown,
    signal: AbortSignal,
  ) => Promise<Placed | undefined>;
  /** Runs a placed call: its answer, kept as the agent gets it. */
  run: (scope: CallScope, tool: string, input: unknown) => Promise<ToolAnswer>;
  log: Log;
}) {
  /** Each agent's key, for this run of Rufi. */
  const keys = new Map<string, string>();
  return {
    /** Rufi's tools for the agent's conversation: the door and its key. */
    registration: (
      agent: string,
      tools: readonly string[],
    ): McpRegistration => {
      let key = keys.get(agent);
      if (key === undefined) {
        key = deps.mcp.keys.issue({
          tools: deps.specs.filter((spec) => tools.includes(spec.name)),
          call: async ({ tool, input, meta, signal }) => {
            const placed = await deps.place(agent, meta, signal);
            if (!placed) {
              deps.log("mcp.refused", { reason: "no_reply" });
              return {
                ok: false,
                text: JSON.stringify({
                  ok: false,
                  error: "No reply is running.",
                }),
              };
            }
            const { call, ...scope } = placed;
            return deps.run(
              {
                ...scope,
                callId: callIdOf(placed.agent, placed.conversation, call),
              },
              tool,
              input,
            );
          },
        });
        keys.set(agent, key);
      }
      return { url: deps.mcp.url(), key };
    },
  };
}
