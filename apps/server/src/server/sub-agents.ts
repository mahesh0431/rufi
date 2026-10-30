// What an agent does with agents (core/tools/agents.ts), in the agent
// system (docs/adr/0026). A child of the calling agent is made by the call
// that starts it, and its id is that call's, so the same call again finds
// it; it is the caller's chat's, on the caller's model and effort, with no
// more of Rufi's tools than the caller has. Each turn's end goes to its
// parent as a done message (the package's). An agent sees how the agents
// below it are, waiting for one to end a turn if it asks, writes to one or
// to its parent, and reads its own conversation or one below it, by pages.
import type { Agents } from "@rufi/agents/agents";
import type { chatAgents } from "../core/chat/agents.ts";
import type { ChatQueue } from "../core/chat/queue.ts";
import { waitMs } from "../core/tools/agents.ts";
import { Refusal, type AgentTools } from "../core/tools/registry.ts";
import type { TurnScope } from "../core/tools/tools.ts";

/** How many turns a page of an agent's conversation holds. */
const PAGE = 10;

export function subAgents(deps: {
  agents: Agents;
  kept: ReturnType<typeof chatAgents>;
  queue: ChatQueue;
}): (scope: TurnScope) => AgentTools {
  const { agents, kept } = deps;
  return (scope) => {
    /** The agent itself or one below it, else nothing: not found. */
    const reachable = (id: string) =>
      id === scope.agent || agents.below(scope.agent).includes(id)
        ? agents.get(id)
        : undefined;
    return {
      start: async ({ title, task, tools }, callId) => {
        const parent = agents.get(scope.agent);
        if (!parent) throw new Error(`No agent ${scope.agent}.`);
        const given = [...new Set(tools ?? parent.tools)];
        const wider = given.filter((tool) => !parent.tools.includes(tool));
        if (wider.length > 0) {
          throw new Refusal(
            `An agent you start can have only tools you have, and you don't have ${wider.join(", ")}. Nothing was started.`,
          );
        }
        // Each step again finds what it did: a crash before the owner is
        // kept leaves an agent the next start removes, its task with it.
        if (!agents.get(callId)) {
          agents.create({
            id: callId,
            parent: scope.agent,
            title,
            provider: parent.provider,
            model: parent.model,
            effort: parent.effort,
            tools: given,
            cwd: parent.cwd,
          });
        }
        agents.send(callId, {
          id: callId,
          sender: scope.agent,
          kind: "queue",
          parts: [task],
        });
        if (!(await kept.owner(callId))) {
          await kept.own({
            agent: callId,
            personId: scope.chat.personId,
            chatId: scope.chat.id,
            root: false,
          });
        }
        agents.admit(callId);
        return { agent: callId, title: agents.get(callId)?.title ?? title };
      },

      status: async (input) => {
        const below = agents.below(scope.agent);
        const asked = input.agents ?? below;
        const ms = waitMs(input);
        // Its own turn ends the wait: the call keeps the turn it came in.
        const ended =
          ms > 0
            ? ((await agents.wait(
                scope.agent,
                scope.turn,
                asked.filter((id) => below.includes(id)),
                ms,
              )) ?? null)
            : undefined;
        return {
          ...(ended !== undefined && { ended: ended?.agent ?? null }),
          agents: asked.map((id) => {
            const found = below.includes(id) ? agents.get(id) : undefined;
            if (!found) return { agent: id, status: "not found" };
            return {
              agent: id,
              title: found.title,
              parent: found.parent === scope.agent ? "self" : found.parent,
              status: found.status,
              result: found.result,
              // The turn the wait ended with asked: its questions come too.
              ...(ended?.agent === id &&
                ended.questions.length > 0 && { questions: ended.questions }),
            };
          }),
        };
      },

      send: ({ to, text, kind = "steer" }, callId) => {
        const self = agents.get(scope.agent);
        const target =
          to === "parent" ? (self?.parent ?? undefined) : reachable(to)?.id;
        if (!self || target === undefined || target === scope.agent) {
          throw new Refusal(
            to === "parent"
              ? "You have no parent: you are Rufi AI. Answer the user in your reply."
              : `No agent ${to} is below you: write to "parent", or to an agent agent_status lists.`,
          );
        }
        agents.send(target, {
          id: callId,
          sender: scope.agent,
          kind,
          parts: [`${self.title} (${self.id}) writes:\n\n${text}`],
          about: "wrote",
        });
        return {
          agent: target,
          sent:
            kind === "queue"
              ? "queued"
              : agents.current(target)?.status === "running"
                ? "steered"
                : "will start the next turn",
        };
      },

      read: async ({ agent, before }) => {
        const id = agent === "self" ? scope.agent : agent;
        const found = reachable(id);
        if (!found) {
          throw new Refusal(
            `No agent ${agent} is you or below you: read "self", or an agent agent_status lists.`,
          );
        }
        const page = agents.history(id, {
          ...(before !== undefined && { before }),
          limit: PAGE,
        });
        // The words Rufi keeps (the person's messages, its own notes) are
        // the chat's, not the agent database's.
        const words = await deps.queue.words(
          scope.chat,
          page.turns.flatMap((turn) =>
            turn.inputs.flatMap((input) =>
              input.parts === null ? [input.id] : [],
            ),
          ),
        );
        return {
          agent: { agent: id, title: found.title, status: found.status },
          turns: page.turns.map((turn) => ({
            turn: turn.id,
            status: turn.status,
            ...(turn.reason !== null && { reason: turn.reason }),
            startedAt: turn.startedAt,
            endedAt: turn.endedAt,
            inputs: turn.inputs.map((input) => ({
              from: input.sender,
              text: input.parts?.join("\n\n") ?? words.get(input.id) ?? null,
            })),
            steps: turn.items
              .filter((item) => item.type !== "text")
              .map(({ type, kind, title, detail, status, text }) => ({
                type,
                kind,
                title,
                detail,
                status,
                text,
              })),
            ...(turn.questions.length > 0 && {
              questions: turn.questions.map(({ title, options }) => ({
                title,
                options,
              })),
            }),
            result: turn.result,
          })),
          earlier: page.earlier,
        };
      },
    };
  };
}
