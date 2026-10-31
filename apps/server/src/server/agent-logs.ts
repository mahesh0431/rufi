// What the chat's sub-agents did, for the screens: each one's line, its own
// Activity as it reported it, and a signal when any of them did something
// (to the chat's screens, and its person's documents).
// Only the agents below a chat's own agent are that chat's.
import type { Agents, Item, KeptTurn } from "@rufi/agents/agents";
import type { AgentLine, AgentLog, SubAgent } from "@rufi/contracts";
import { callIdOf, type chatAgents } from "../core/chat/agents.ts";
import { shownStatus } from "../core/chat/transcript.ts";

/** Characters of a result a sub-agent's line shows. */
const RESULT_CHARS = 280;

/** Turns read at a time while a log gathers its lines. */
const TURNS_AT_ONCE = 20;

/** How long the screens wait to hear of more before they read again. */
const SETTLE_MS = 250;

/** A step's id in a log: its turn's reference, then its item's id. */
const lineId = (ref: string, item: string) =>
  `${ref}.${Buffer.from(item).toString("base64url")}`;

export function agentLogs(deps: {
  agents: Agents;
  kept: Pick<ReturnType<typeof chatAgents>, "root" | "owner">;
  /** Tells the person's documents screens: a reader's status shows there. */
  documents?: ((personId: string) => void) | undefined;
}) {
  const { agents, kept } = deps;
  const listeners = new Map<string, Set<() => void>>();
  /** The roots whose trees did something, before the screens hear it. */
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The sub-agent a step of this agent started, by the step's call. */
  const started = (
    agent: string,
    item: Pick<Item, "type" | "conversation" | "id">,
  ): string | undefined => {
    if (item.type !== "step") return undefined;
    const child = callIdOf(agent, item.conversation, item.id);
    return agents.get(child)?.parent === agent ? child : undefined;
  };

  /** The agent, when it is below the chat's own agent. */
  const mine = async (chatId: string, agent: string) => {
    const root = await kept.root(chatId);
    return root !== undefined && agents.below(root).includes(agent)
      ? agents.get(agent)
      : undefined;
  };

  const from = (sender: string) =>
    sender === "rufi"
      ? "Rufi"
      : sender === "person"
        ? "You"
        : (agents.get(sender)?.title ?? sender);

  /**
   * A turn's lines in the order they happened: each message it took when it
   * was delivered, what it reported when first reported, with the questions
   * it asked; then how it ended.
   */
  const linesOf = (agent: string, turn: KeptTurn): AgentLine[] => {
    const ended = turn.endedAt !== null;
    const plain = { activity: null, detail: null, status: null };
    const happened = [
      ...turn.inputs.map((input) => ({
        at: input.at,
        line: {
          id: `${turn.id}:${input.id}`,
          kind: "message",
          from: from(input.sender),
          text: (input.parts ?? []).join("\n\n"),
          ...plain,
          updatedAt: input.at,
        } satisfies AgentLine,
      })),
      ...turn.items.map((item) => {
        const child = started(agent, item);
        return {
          at: item.createdAt,
          line: {
            id: lineId(item.turn, item.id),
            kind:
              item.type === "text"
                ? "reply"
                : item.type === "reasoning"
                  ? "reasoning"
                  : "activity",
            text: (item.type === "step" ? item.title : item.text) ?? "",
            activity:
              item.type === "note"
                ? "note"
                : item.type === "step"
                  ? (item.kind as AgentLine["activity"])
                  : null,
            detail: item.type === "step" ? item.detail : null,
            status: item.type === "text" ? null : shownStatus(item, ended),
            updatedAt: item.updatedAt,
            ...(child !== undefined && { agent: child }),
          } satisfies AgentLine,
        };
      }),
      // A question shows with the item it came with, after it.
      ...turn.questions.map((question) => ({
        at:
          turn.items.find((item) => item.id === question.item)?.createdAt ??
          question.at,
        line: {
          id: `${turn.id}:${question.item}:${String(question.number)}`,
          kind: "question",
          text: question.title,
          ...plain,
          detail: question.options.join(" · "),
          updatedAt: question.at,
        } satisfies AgentLine,
      })),
    ];
    // At the same moment, a message comes before what it brought.
    const lines: AgentLine[] = happened
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .map(({ line }) => line);
    if (turn.status === "stopped" || turn.status === "failed") {
      lines.push({
        id: `${turn.id}:end`,
        kind: "end",
        text: turn.result ?? turn.reason ?? "",
        activity: null,
        detail: null,
        status: turn.status,
        updatedAt: turn.endedAt ?? turn.startedAt,
      });
    }
    return lines;
  };

  /** The line before a turn on another model or effort than `earlier`. */
  const modelLine = (earlier: KeptTurn, turn: KeptTurn): AgentLine => ({
    id: `${turn.id}:model`,
    kind: "model",
    text: "",
    activity: null,
    detail: null,
    status: null,
    updatedAt: turn.startedAt,
    changed: {
      from: { model: earlier.model, effort: earlier.effort },
      to: { model: turn.model, effort: turn.effort },
    },
  });

  return {
    started,

    /** The chat's sub-agents, oldest first. */
    list: async (chatId: string): Promise<SubAgent[]> => {
      const root = await kept.root(chatId);
      if (root === undefined) return [];
      return agents.below(root).flatMap((id) => {
        const agent = agents.get(id);
        if (!agent) return [];
        const result = agent.result?.replace(/\s+/g, " ").trim() ?? null;
        const working =
          agent.status === "running" || agent.status === "continuing";
        return [
          {
            id,
            title: agent.title,
            status: agent.status,
            result:
              result !== null && result.length > RESULT_CHARS
                ? `${result.slice(0, RESULT_CHARS).trimEnd()}…`
                : result,
            parent: agent.parent === root ? null : agent.parent,
            since: working
              ? (agents.history(id, { limit: 1 }).turns[0]?.startedAt ?? null)
              : null,
            model: agent.model,
            effort: agent.effort,
          },
        ];
      });
    },

    /**
     * A sub-agent's last `last` lines, oldest first; undefined when the chat
     * has no such agent (its log is gone).
     */
    log: async (
      chatId: string,
      agent: string,
      last: number,
    ): Promise<AgentLog | undefined> => {
      if (!(await mine(chatId, agent))) return undefined;
      const lines: AgentLine[] = [];
      let before: string | undefined;
      /** The turn after the page read last, which a model line may open. */
      let next: KeptTurn | undefined;
      do {
        const page = agents.history(agent, {
          ...(before !== undefined && { before }),
          limit: TURNS_AT_ONCE,
        });
        const turns = next === undefined ? page.turns : [...page.turns, next];
        // Each turn after the first, on another model or effort, says so
        // first; the page's first waits for the page before it.
        const read = turns.flatMap((turn, at) => {
          const earlier = turns[at - 1];
          return [
            ...(earlier !== undefined &&
            (earlier.model !== turn.model || earlier.effort !== turn.effort)
              ? [modelLine(earlier, turn)]
              : []),
            ...(turn === next ? [] : linesOf(agent, turn)),
          ];
        });
        lines.unshift(...read);
        next = page.turns[0];
        before = page.earlier ?? undefined;
      } while (before !== undefined && lines.length < last);
      const start = Math.max(0, lines.length - last);
      return {
        lines: lines.slice(start),
        earlier: start > 0 || before !== undefined,
      };
    },

    /**
     * Stops one of the chat's sub-agents and every agent it started, as
     * the person asks on the screens; false when the chat has no such
     * agent. Its stopped message goes to the agent that started it.
     */
    stop: async (chatId: string, agent: string): Promise<boolean> => {
      if (!(await mine(chatId, agent))) return false;
      await agents.stop(agent, "person", { children: true });
      return true;
    },

    /** Everything a sub-agent's step gave; undefined when there is no such step. */
    step: async (chatId: string, agent: string, line: string) => {
      if (!(await mine(chatId, agent))) return undefined;
      const dot = line.lastIndexOf(".");
      if (dot === -1) return undefined;
      const found = agents.item(
        agent,
        line.slice(0, dot),
        Buffer.from(line.slice(dot + 1), "base64url").toString(),
      );
      return found && { details: found.payload };
    },

    /**
     * A sub-agent did something: the screens of its chat hear it soon. A
     * chat's own agent shows in the chat as it goes.
     */
    changed: (agent: string) => {
      const found = agents.get(agent);
      if (!found || found.parent === null) return;
      const { root } = found;
      pending.add(root);
      timer ??= setTimeout(() => {
        timer = undefined;
        const roots = [...pending];
        pending.clear();
        for (const one of roots) {
          // Read again by then, or never: what shows them reads at once.
          void kept
            .owner(one)
            .then((owner) => {
              for (const listener of listeners.get(owner?.chatId ?? "") ?? []) {
                listener();
              }
              if (owner) deps.documents?.(owner.personId);
            })
            .catch(() => undefined);
        }
      }, SETTLE_MS);
    },

    /** Hears when the chat's sub-agents did something; returns how to stop. */
    subscribe: (chatId: string, listener: () => void) => {
      const set = listeners.get(chatId) ?? new Set();
      set.add(listener);
      listeners.set(chatId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(chatId);
      };
    },

    close: () => {
      clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}

export type AgentLogs = ReturnType<typeof agentLogs>;
