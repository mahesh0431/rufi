// The agent system as Rufi starts it (docs/adr/0024). The package keeps its
// own database beside the record; before anything goes to a provider, the
// two are brought into step in this order (docs/how-rufi-works.md): a new
// agent database ends Rufi's links to the old one; owners and admission
// agree; each chat has its own agent, Rufi AI, which takes over the chat's
// thread; Rufi reads the events it hasn't; and hand-overs Rufi claimed
// that the package never saved are settled by their provider. Dispatching
// starts after Rufi's own recovery (core.ts).
import { join } from "node:path";
import { DEFAULT_EFFORT } from "@rufi/contracts";
import { createAgents, type Agents, type Host } from "@rufi/agents/agents";
import type { ProviderAdapter } from "@rufi/agents/provider";
import type { AgentStore } from "@rufi/agents/store";
import { v7 as uuid } from "uuid";
import {
  chatAgents,
  sentAs,
  type Answer,
  type Claimed,
} from "../core/chat/agents.ts";
import type { Store } from "../core/store/database.ts";
import { errorCode, type Log } from "../platform/logs.ts";

/** `agents.sqlite` in Rufi's data folder. */
export const agentsPath = (home: string) => join(home, "agents.sqlite");

export interface AgentSystem {
  agents: Agents;
  /** Stops reading events and lets go of every conversation. */
  close: () => Promise<void>;
}

/** Where the package holds an input Rufi claimed: it settles those itself. */
const HELD = new Set(["handing_over", "delivered", "not_sure"]);

export async function startAgents(options: {
  store: AgentStore;
  /** The record, written. */
  record: Store;
  adapters: readonly ProviderAdapter[];
  /** What a conversation opens with, and Rufi's claim of each hand-over. */
  host: Pick<Host, "opening" | "claim">;
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
  let cursor = await kept.begin(store.generation);
  const agents = createAgents({
    store,
    adapters: options.adapters,
    host: { ...options.host, ledger: kept.ledger },
    onError: failed,
  });

  // 2. Owners and admission agree: an agent runs only with its owner.
  const owners = await kept.owners();
  for (const owner of owners) {
    if (agents.get(owner.agent)) agents.admit(owner.agent);
    else await kept.drop(owner.agent);
  }
  const owned = new Set(owners.map((owner) => owner.agent));
  const orphans = agents.unadmitted().filter((id) => !owned.has(id));
  if (orphans.length > 0) await agents.forget(orphans);

  // Each chat's own agent: made, owned (with the thread it takes over, in
  // the ledger), then admitted. A crash between leaves an orphan, removed
  // above at the next start, or an owner, admitted there.
  for (const chat of await kept.unrooted()) {
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
  }

  // 3. Rufi reads every event after its cursor, now and as they commit,
  // one reading at a time.
  let reading = Promise.resolve();
  const read = () => {
    reading = reading
      .then(async () => {
        for (;;) {
          const last = store.eventsAfter(cursor).at(-1);
          if (!last) return;
          await kept.advance(store.generation, last.number);
          cursor = last.number;
        }
      })
      .catch(failed);
    return reading;
  };
  const unfollow = store.onCommit(() => void read());
  await read();

  // 5. Claims the package never saved, asked of the provider by the
  // conversation they went to, in the same generation too.
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
    const said = await agents.received(first.agent, first.conversation, ids);
    for (const id of ids) answers.set(id, said.get(id) ?? "unknown");
  }
  if (answers.size > 0) await kept.settle(answers);

  return {
    agents,
    close: async () => {
      unfollow();
      await reading;
      await agents.close();
    },
  };
}
