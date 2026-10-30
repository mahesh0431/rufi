// One terminal ask: its MCP listener, thread and turn end with the command.
// The command chooses the person, record and sign-in at its composition root;
// the MCP listener offers Rufi's skills as the chat's does.
import { Effect } from "effect";
import { v7 as uuid } from "uuid";
import {
  agentCall,
  type AgentEvent,
  type AgentHost,
  type AgentRuntime,
  type TurnEnd,
} from "../agent/runtime.ts";
import { callOf } from "../agent/codex/events.ts";
import type { forAgent } from "../core/tools/tools.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { SKILLS } from "../core/skills/skills.ts";
import {
  mcpEndpoint,
  mcpKeys,
  serveMcp,
  skillResources,
} from "../server/mcp.ts";

/** Runs one reply; only the command's chosen person can be read. */
export const ask = (
  question: string,
  deps: {
    model: string;
    instructions: string;
    tools: ReturnType<typeof forAgent>;
    agent: (host: AgentHost) => AgentRuntime;
    onEvent: (event: AgentEvent) => void;
    onStop?: () => void;
    log: Log;
  },
) =>
  Effect.gen(function* () {
    const { tools, log } = deps;
    const ended = Promise.withResolvers<TurnEnd>();
    let threadId: string | undefined;
    // Rufi's tools over MCP, on a listener of the command's own.
    const keys = mcpKeys();
    let port = 0;
    const listening = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          serveMcp(
            mcpEndpoint({
              keys,
              port: () => port,
              log,
              resources: skillResources(SKILLS),
            }),
          ),
        catch: (error) => error,
      }),
      (server) => Effect.promise(() => server.close()),
    );
    port = listening.port;
    const agent = yield* Effect.acquireRelease(
      Effect.sync(() =>
        deps.agent({
          onEvent: (event) => {
            deps.onEvent(event);
            if (event.type === "turnEnded") ended.resolve(event.end);
          },
        }),
      ),
      (runtime) => Effect.promise(() => runtime.close()),
    );
    let caller:
      | { turnId: string; call: ReturnType<typeof tools.forTurn> }
      | undefined;
    // The thread's key: its calls run only for its running reply.
    const key = keys.issue({
      tools: tools.specs,
      call: async (call) => {
        // Codex's own: the ask runs on Codex directly.
        const made = callOf(call.meta);
        const turnId = made.turnId;
        if (
          made.threadId === undefined ||
          made.threadId !== threadId ||
          turnId === undefined ||
          agent.activeTurn(made.threadId) !== turnId
        ) {
          return {
            ok: false,
            text: JSON.stringify({ ok: false, error: "No reply is running." }),
          };
        }
        if (caller?.turnId !== turnId) {
          caller = { turnId, call: tools.forTurn() };
        }
        const answer = await caller.call(call.tool, call.input, made.callId);
        if (answer.stopTurn !== undefined) {
          agent
            .stop(made.threadId, turnId, {
              status: "failed",
              text: answer.stopTurn,
            })
            .catch((error: unknown) => {
              log("codex.interrupt_failed", { error: errorCode(error) });
            });
        }
        return answer;
      },
    });
    const op = new AbortController();
    const end = yield* agentCall(
      async () => {
        const thread = await agent.startThread(
          {
            model: deps.model,
            instructions: deps.instructions,
            tools: { url: `http://127.0.0.1:${String(port)}/mcp`, key },
          },
          op.signal,
        );
        threadId = thread.threadId;
        await agent.send(
          threadId,
          { id: uuid(), input: [question] },
          op.signal,
        );
        return ended.promise;
      },
      async () => {
        op.abort();
        if (threadId !== undefined) await agent.stop(threadId);
        ended.resolve({
          status: "interrupted",
          reason: "stopped",
          text: "Stopped.",
        });
      },
      deps.onStop,
    );
    return end;
  });
