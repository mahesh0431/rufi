// The agent system as Rufi starts it (docs/adr/0024). The package keeps its
// own database beside the record; before anything goes to a provider, the
// two are brought into step in this order (docs/how-rufi-works.md): a new
// agent database ends Rufi's links to the old one; owners and admission
// agree; each chat has its own agent, Rufi AI, which takes over the chat's
// thread; and Rufi reads the events it hasn't. Once the chat is open,
// hand-overs Rufi claimed that the package never saved are settled by their
// provider (recover); dispatching starts after that and Rufi's own recovery
// (core.ts).
import { join } from "node:path";
import { DEFAULT_EFFORT } from "@rufi/contracts";
import { createAgents, type Agents, type Host } from "@rufi/agents/agents";
import type { ProviderAdapter, ProviderEvent } from "@rufi/agents/provider";
import type { AgentStore, StoredEvent } from "@rufi/agents/store";
import type { Kysely } from "kysely";
import { v7 as uuid } from "uuid";
import {
  chatAgents,
  sentAs,
  type Answer,
  type Claimed,
  type Unrooted,
} from "../core/chat/agents.ts";
import type { Store } from "../core/store/database.ts";
import type { Tables } from "../core/store/tables.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** `agents.sqlite` in Rufi's data folder. */
export const agentsPath = (home: string) => join(home, "agents.sqlite");

export interface AgentSystem {
  agents: Agents;
  /** The chat's own agent, Rufi AI: made, owned and admitted if it has none. */
  root: (chatId: string) => Promise<string>;
  /**
   * Settles the hand-overs Rufi claimed that the package never saved, by
   * what their provider says, once the host can open their conversations;
   * before the package hands anything over.
   */
  recover: () => Promise<void>;
  /** Stops reading events and lets go of every conversation. */
  close: () => Promise<void>;
}

/**
 * Applies an event of the agent database to Rufi's record, with `advance`
 * (Rufi's cursor, past this event) in the same transaction. False: the
 * event changes nothing there.
 */
export type Apply = (
  event: StoredEvent,
  advance: (trx: Kysely<Tables>) => Promise<void>,
) => Promise<boolean>;

/** Where the package holds an input Rufi claimed: it settles those itself. */
const HELD = new Set(["handing_over", "delivered", "not_sure"]);

export async function startAgents(options: {
  store: AgentStore;
  /** The record, written. */
  record: Store;
  adapters: readonly ProviderAdapter[];
  /** What a conversation opens with, and Rufi's claim of each hand-over. */
  host: Pick<Host, "opening" | "claim">;
  /** What the package shows of each open conversation as it comes. */
  live?: (agent: string, conversation: string, event: ProviderEvent) => void;
  /**
   * A new conversation of an owned agent, once in the ledger, before any
   * of Rufi's content goes into it.
   */
  opened?: Host["ledger"];
  /** What Rufi applies of the events it reads. */
  apply?: Apply;
  /** Rufi AI's tools, by name, and where it works. */
  tools: readonly string[];
  cwd: string;
  /** A chat's model when it has chosen none. */
  model: string;
  log: Log;
  now?: () => string;
}): Promise<AgentSystem> {
  const { store, log } = options;
  const kept = chatAgents(options.record, options.now);
  const failed = (error: unknown) => {
    log("agents.failed", { error: errorCode(error) });
  };

  // 1. An agent database Rufi hasn't read: its links to the old one end.
  // An older copy of one it has read (its events end before Rufi's
  // cursor) is renewed as a new one: its waiting inputs may have gone
  // already, so none of its agents runs again.
  const known = await kept.cursor();
  if (
    known?.generation === store.generation &&
    known.number > store.highWater()
  ) {
    store.renew();
  }
  let cursor = await kept.begin(store.generation);
  const agents = createAgents({
    store,
    adapters: options.adapters,
    host: {
      ...options.host,
      ledger: async (entry) => {
        await kept.ledger(entry);
        await options.opened?.(entry);
      },
    },
    onError: failed,
    ...(options.live && { live: options.live }),
  });

  // 2. Owners and admission agree: an agent with no owner, admitted or
  // not, goes with everything below it and its waiting inputs; an owner
  // whose agent is gone goes; an owned agent is admitted. Each chat's own
  // agent has Rufi's tools as they are now; the agents it starts keep the
  // ones they were given.
  const owners = await kept.owners();
  const owned = new Set(owners.map((owner) => owner.agent));
  const unowned = agents.list().filter((id) => !owned.has(id));
  if (unowned.length > 0) await agents.forget(unowned);
  for (const owner of owners) {
    const agent = agents.get(owner.agent);
    if (!agent) {
      await kept.drop(owner.agent);
      continue;
    }
    if (owner.root) {
      agents.configure(agent.id, {
        model: agent.model,
        effort: agent.effort,
        tools: options.tools,
      });
    }
    agents.admit(agent.id);
  }

  // Each chat's own agent: made, owned (with the thread it takes over, in
  // the ledger), then admitted. A crash between leaves an agent with no
  // owner, removed above at the next start, or an owner, admitted there.
  const make = async (chat: Unrooted) => {
    const id = uuid();
    agents.create({
      id,
      title: "Rufi AI",
      provider: chat.thread?.provider ?? "codex",
      model: chat.model ?? chat.thread?.model ?? options.model,
      effort: chat.effort ?? DEFAULT_EFFORT,
      tools: options.tools,
      cwd: options.cwd,
      ...(chat.thread && { adopt: chat.thread.ref }),
    });
    await kept.own(
      { agent: id, personId: chat.personId, chatId: chat.chatId, root: true },
      chat.thread,
    );
    agents.admit(id);
    return id;
  };
  for (const chat of await kept.unrooted()) await make(chat);

  // 3. Rufi reads every event after its cursor, now and as they commit,
  // one reading at a time. What it applies of one moves the cursor in the
  // same transaction.
  let reading = Promise.resolve();
  const read = () => {
    reading = reading
      .then(async () => {
        const { generation } = store;
        for (;;) {
          const events = store.eventsAfter(cursor);
          const last = events.at(-1);
          if (!last) return;
          for (const event of events) {
            const applied = await options.apply?.(event, (trx) =>
              kept.advance(generation, event.number, trx),
            );
            if (applied) cursor = event.number;
          }
          if (cursor < last.number) {
            await kept.advance(generation, last.number);
            cursor = last.number;
          }
        }
      })
      .catch(failed);
    return reading;
  };
  const unfollow = store.onCommit(() => void read());
  await read();

  return {
    agents,
    // 5. Claims the package never saved, asked of the provider by the
    // conversation they went to, in the same generation too.
    recover: async () => {
      const claims = (await kept.claimed()).filter(
        (claim) => !HELD.has(agents.input(claim.id)?.state ?? ""),
      );
      const answers = new Map<string, Answer>();
      const byConversation = Map.groupBy(claims, (claim: Claimed) =>
        sentAs(claim.agent, claim.conversation),
      );
      for (const [first, ...rest] of byConversation.values()) {
        if (!first) continue;
        const ids = [first, ...rest].map((claim) => claim.id);
        const said = await agents.received(
          first.agent,
          first.conversation,
          ids,
        );
        for (const id of ids) answers.set(id, said.get(id) ?? "unknown");
      }
      if (answers.size > 0) await kept.settle(answers);
    },
    root: async (chatId) => {
      const found = await kept.root(chatId);
      if (found !== undefined) return found;
      const [chat] = await kept.unrooted(chatId);
      if (!chat) throw new Error(`No chat ${chatId}.`);
      return make(chat);
    },
    close: async () => {
      unfollow();
      await reading;
      await agents.close();
    },
  };
}
