// What an agent does with agents (core/tools/agents.ts), in the agent
// system (docs/adr/0026). A child of the calling agent is made by the call
// that starts it, and its id is that call's, so the same call again finds
// it; it is the caller's chat's, on the caller's model and effort, with no
// more of Rufi's tools than the caller has. Each turn's end goes to its
// parent as a done message (the package's). An agent sees how the agents
// below it are, writes to one or to its parent, reads the conversation of
// any agent in its chat, its own too, by pages, stops one below it or
// itself, with or without everything under it, and manages what waits for
// it and for the agents below it: the person's messages and Rufi's notes
// change in Rufi first, as the screens change them.
import type { Agents, WaitingInput } from "@rufi/agents/agents";
import type { QueueItem } from "@rufi/contracts";
import type { chatAgents } from "../core/chat/agents.ts";
import type { ChatQueue } from "../core/chat/queue.ts";
import { Refusal, type AgentTools } from "../core/tools/registry.ts";
import type { TurnScope } from "../core/tools/tools.ts";
import { errorCode, type Log } from "../platform/logs.ts";
import { ChatRefusal, type Chat } from "./chat.ts";

/** How many turns a page of an agent's conversation holds. */
const PAGE = 10;

export function subAgents(deps: {
  agents: Agents;
  kept: ReturnType<typeof chatAgents>;
  queue: ChatQueue;
  log: Log;
  /** The chat's waiting messages, as its screens change them: Rufi first. */
  messages: () => Chat["queue"];
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

      status: ({ agents: asked }) => {
        const below = agents.below(scope.agent);
        return {
          agents: (asked ?? below).map((id) => {
            const found = below.includes(id) ? agents.get(id) : undefined;
            if (!found) return { agent: id, status: "not found" };
            return {
              agent: id,
              title: found.title,
              parent: found.parent === scope.agent ? "self" : found.parent,
              status: found.status,
              result: found.result,
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
        // The chat's agents share its root.
        const found = agents.get(id);
        if (!found || found.root !== agents.get(scope.agent)?.root) {
          throw new Refusal(
            `No agent ${agent} is in your chat: read "self", or an agent agent_status lists.`,
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

      stop: ({ agent, with_children: children = false }) => {
        const id = agent === "self" ? scope.agent : agent;
        if (id !== scope.agent && !agents.below(scope.agent).includes(id)) {
          throw new Refusal(
            `No agent ${agent} is you or below you: stop "self", or an agent agent_status lists.`,
          );
        }
        // It goes on after this answer: an agent can stop itself.
        agents.stop(id, scope.agent, { children }).catch((error: unknown) => {
          deps.log("agents.failed", { error: errorCode(error) });
        });
        return { stopping: children ? [id, ...agents.below(id)] : [id] };
      },

      waiting: async ({ action, id, text, ids }) => {
        const mine = [scope.agent, ...agents.below(scope.agent)];
        const root = agents.get(scope.agent)?.root;
        const chat = deps.messages();
        /** Rufi's waiting rows, when the chat's own agent is among them. */
        const kept = async () =>
          root !== undefined && mine.includes(root)
            ? new Map(
                (await chat.list(scope.chat)).items
                  .filter((item) => item.state === "waiting")
                  .map((item) => [item.id, item]),
              )
            : new Map<string, QueueItem>();
        const from = (sender: string) =>
          sender === "person"
            ? "user"
            : sender === "rufi"
              ? "Rufi"
              : sender === scope.agent
                ? "self"
                : `${agents.get(sender)?.title ?? "An agent"} (${sender})`;
        const held = (hold: string | null, line: string | null) =>
          hold === null ? null : (line ?? hold);
        const list = async () => {
          const rows = await kept();
          return {
            messages: mine.flatMap((agent) => {
              const queue = agent === scope.agent ? "self" : agent;
              const listed = agents
                .waiting(agent)
                .flatMap((input: WaitingInput) => {
                  const row = rows.get(input.id);
                  rows.delete(input.id);
                  if (input.parts === null && !row) return [];
                  return [
                    {
                      id: input.id,
                      queue,
                      from: from(input.sender),
                      kind: input.kind,
                      text: row?.text ?? input.parts?.join("\n\n") ?? "",
                      held: row
                        ? held(row.held, row.heldText)
                        : held(input.held, input.heldText),
                    },
                  ];
                });
              // Rufi's rows not in the agent's queue yet, behind a reading.
              const later =
                agent === root
                  ? [...rows.values()].map((row) => ({
                      id: row.id,
                      queue,
                      from: from(row.origin),
                      text: row.text,
                      held: held(row.held, row.heldText),
                    }))
                  : [];
              return [...listed, ...later];
            }),
          };
        };
        if (action === "list") return list();

        /** Where a message waits: Rufi's row, or an agent's input. */
        const find = async (message: string | undefined) => {
          if (message !== undefined) {
            const row = (await kept()).get(message);
            if (row && root !== undefined) return { agent: root, row };
            const input = agents.input(message);
            if (input?.state === "waiting" && mine.includes(input.agent)) {
              return { agent: input.agent, row: undefined };
            }
          }
          throw new Refusal(
            `No message ${message ?? ""} waits for you or an agent below you: list them, and give an id from the list.`,
          );
        };
        // The person's refusals, as the screens get them.
        const asPerson = async (change: () => Promise<unknown>) => {
          try {
            await change();
          } catch (error) {
            if (error instanceof ChatRefusal) throw new Refusal(error.message);
            throw error;
          }
        };
        switch (action) {
          case "edit": {
            const found = await find(id);
            if (text === undefined) throw new Refusal("edit needs text.");
            if (found.row) {
              await asPerson(() => chat.edit(scope.chat, found.row.id, text));
            } else if (!agents.edit(id ?? "", [text])) {
              throw new Refusal("That message isn't waiting any more.");
            }
            break;
          }
          case "remove": {
            const found = await find(id);
            if (found.row) {
              await asPerson(() => chat.remove(scope.chat, found.row.id));
            } else agents.remove([id ?? ""]);
            break;
          }
          case "steer": {
            const found = await find(id);
            const { row } = found;
            if (row) {
              await asPerson(() =>
                row.held === null
                  ? chat.steer(scope.chat, row.id)
                  : chat.send(scope.chat, row.id),
              );
            } else agents.steer(id ?? "");
            break;
          }
          case "reorder": {
            const found = await find(ids?.[0]);
            const order = ids ?? [];
            if (found.agent === root) {
              const rows = await kept();
              await asPerson(() =>
                chat.reorder(
                  scope.chat,
                  order.filter((message) => rows.has(message)),
                ),
              );
            }
            agents.reorder(found.agent, order);
            break;
          }
        }
        return list();
      },
    };
  };
}
