// Rufi AI's replies, through the agent package (docs/adr/0024). Each chat's
// own agent, Rufi AI, keeps its conversation and turns in the package, and
// the package's queue hands the chat's waiting messages over, in order: the
// chat puts each in by its id without its words, as a steer or queued, and
// the package claims them from the chat's queue as they go
// (server/chat.ts). What the package shows of a conversation as it comes
// reaches the chat as the agent's events; what became of each turn and each
// hand-over is applied from the package's events, with Rufi's cursor.
import type { Agent, Claim, Hold, Opening } from "@rufi/agents/agents";
import {
  type McpRegistration,
  type ProviderEvent,
  type TurnEnd as Ended,
  type UsageWindow,
} from "@rufi/agents/provider";
import { SIGNED_OUT } from "@rufi/contracts";
import { type AgentEvent, type Model, type TurnEnd } from "../agent/runtime.ts";
import { chatAgents, sentAs } from "../core/chat/agents.ts";
import { UNKNOWN_PROVIDER } from "../core/chat/models.ts";
import type {
  AgentMessage,
  ChatRow,
  Step,
  Transcripts,
} from "../core/chat/transcript.ts";
import { startAgents, type AgentSystem, type Apply } from "./agents.ts";
import { agentLogs, type AgentLogs } from "./agent-logs.ts";
import type { Placed } from "./door.ts";

/** What Rufi AI does, as it comes: its thread is its conversation. */
export type RufiAiEvent = (
  | Exclude<AgentEvent, { type: "message" | "turnStarted" }>
  | {
      threadId: string;
      type: "turnStarted";
      turnId: string;
      /** The inputs it took: the chat's rows, by their ids. */
      inputs: readonly string[];
      /** The messages of Rufi AI's agents among them. */
      messages?: readonly AgentMessage[];
    }
) & {
  /** Its item's place in its turn, as the package keeps it. */
  position?: number;
  /** The sub-agent its step started. */
  agent?: string;
};

/** What the chat gives Rufi AI, and hears from it. */
export interface RufiAiHost {
  onEvent: (event: RufiAiEvent) => void;
  /** Resolves once what the chat was told so far is saved. */
  saved: () => Promise<void>;
  /**
   * What a conversation of one of the chat's agents opens with now: Rufi's
   * tools are the agent's own, with its key. A sub-agent's names the agent
   * that started it.
   */
  opening: (chat: ChatRow, agent: OpeningAgent) => Promise<ChatOpening>;
  /**
   * Claims a row of the chat's queue as it goes to the agent's conversation
   * `sentAs`: its words, or that it doesn't go (Host.claim).
   */
  claim: (
    chat: ChatRow,
    input: string,
    sentAs: string,
  ) => Promise<Claim | undefined>;
  /** What the package did changed the chat's waiting messages. */
  changed: (chat: ChatRow) => void;
}

/** The agent whose conversation opens. */
export interface OpeningAgent {
  id: string;
  title: string;
  tools: readonly string[];
  /**
   * The agent that started it, and whether that is Rufi AI; none for the
   * chat's own, Rufi AI.
   */
  parent?: { title: string; rufiAi: boolean };
}

/** What a chat's conversation is given each time it opens. */
export interface ChatOpening {
  instructions: string;
  /** The version of the rules in `instructions`. */
  version: string;
  tools: McpRegistration;
  /** A new conversation's earlier history, read as it opens. */
  seed: () => Promise<string | undefined>;
}

/** A provider's usage now and when its limits reset, as it reported them. */
export interface ProviderUsage {
  provider: string;
  windows: readonly UsageWindow[];
}

/** A model a provider offers now, with the provider it runs on. */
export interface OfferedModel extends Model {
  provider: string;
  /** The efforts it takes, as the provider names them. */
  efforts: readonly string[];
  defaultEffort?: string;
}

/** Rufi AI for today's chat: each chat's own agent, its thread its conversation. */
export interface RufiAi {
  provider: string;
  /** The models the providers offer now. */
  models: (signal?: AbortSignal) => Promise<OfferedModel[]>;
  /** The chat's next turns run on its model and effort. */
  configure: (chat: ChatRow) => Promise<void>;
  /**
   * The chat's conversation opens again at its next turn, with what the chat
   * gives then: its own, or a new one (`fresh`). Refused while it is in use.
   */
  reopen: (chat: ChatRow, fresh: boolean) => Promise<void>;
  /** The rules' version the chat's open conversation got; none when it isn't open. */
  rules: (chat: ChatRow) => Promise<string | undefined>;
  /** Whether a turn of the chat's agent starts or runs now. */
  busy: (chat: ChatRow) => Promise<boolean>;
  /** Whether a reply starts or runs in the thread now. */
  running: (threadId: string) => boolean;
  /** The running reply that may still use Rufi's tools, unless it stops. */
  activeTurn: (threadId: string) => string | undefined;
  /**
   * The running turn of the agent an agent's call to Rufi's tools belongs
   * to, with whose the agent is and its tools. Nothing: no turn runs, a
   * Stop closed it, or the call has no id; the call is refused.
   */
  place: (agent: string, meta: unknown) => Promise<Placed | undefined>;
  /**
   * Puts the chat's rows in its agent's queue by their ids, each once, then
   * the agent's waiting ones among `order` in that order. The package claims
   * their words from the chat as they go. A steer goes into the running
   * turn; when there is none, it starts the next.
   */
  queue: (
    chat: ChatRow,
    rows: readonly {
      id: string;
      sender: string;
      kind: "queue" | "steer";
    }[],
    order: readonly string[],
  ) => Promise<void>;
  /** Where a row is in its agent's queue; nothing when it isn't there. */
  input: (input: string) => { state: string; held: string | null } | undefined;
  /** These rows don't go: removed from the agent's queue. */
  remove: (inputs: readonly string[]) => void;
  /** The waiting row goes in as a steer: into the running reply, or next. */
  steer: (input: string) => void;
  /** These rows' holds lift: they go again. */
  release: (inputs: readonly string[]) => void;
  /** The person's Stop: the chat's reply stops, and what waits goes on. */
  stop: (chat: ChatRow) => Promise<void>;
  /** Rufi stops the reply `turnId` in the thread, if it runs; `end` says why. */
  cut: (threadId: string, turnId: string, end?: TurnEnd) => Promise<void>;
  /** Takes no more: what is under way is settled as far as it can be. */
  close: () => Promise<void>;
}

/** The package's events Rufi applies to a chat. */
const APPLIED = new Set([
  "turn.started",
  "turn.ended",
  "input.delivered",
  "input.held",
  "input.waiting",
  "input.released",
]);

/** An input's hold as the chat shows it: signed out with Rufi's line. */
/** How many of a sub-agent's turns its new conversation hears. */
const SEED_TURNS = 10;

const holdOf = (held: Hold, text: string) =>
  held === "signed_out"
    ? { held, text: SIGNED_OUT }
    : {
        // Held at the restarts' cap: not sent, as a Stop's.
        held:
          held === "open_failed" || held === "stopped"
            ? held
            : held === "restarts"
              ? ("stopped" as const)
              : ("failed" as const),
        text,
      };

/** How a turn ended, as today's chat shows it. */
function endOf(end: Ended): TurnEnd {
  switch (end.status) {
    case "done":
      return { status: "completed" };
    case "stopped":
      return { status: "interrupted", reason: "stopped", text: "Stopped." };
    case "failed":
      return {
        status: "failed",
        reason:
          end.reason === "signed_out"
            ? "sign_in"
            : end.reason === "process_died" || end.reason === "other"
              ? "provider_failed"
              : end.reason,
        ...(end.text !== undefined && { text: end.text }),
        ...(end.resetsAt !== undefined && { resetsAt: end.resetsAt }),
        ...(end.reason === "process_died" && { died: true as const }),
      };
  }
}

/** A provider event as one of today's agent events, in `threadId`. */
function eventOf(threadId: string, event: ProviderEvent): RufiAiEvent {
  const turnId = event.turn;
  switch (event.type) {
    case "turnStarted":
      return { threadId, type: "turnStarted", turnId, inputs: event.inputs };
    case "text":
    case "note":
      return {
        threadId,
        type: event.type,
        turnId,
        itemId: event.item,
        delta: event.delta,
        ...(event.done && { done: true }),
      };
    case "thinking":
      return {
        threadId,
        type: "thinking",
        turnId,
        itemId: event.item,
        delta: event.delta,
      };
    case "question":
      return {
        threadId,
        type: "question",
        turnId,
        itemId: event.item,
        title: event.title,
        options: [...event.options],
      };
    case "reasoning":
      return {
        threadId,
        type: "reasoning",
        turnId,
        itemId: event.item,
        summary: event.summary,
        details: event.payload,
      };
    case "step":
      return {
        threadId,
        type: "activity",
        turnId,
        itemId: event.item,
        activity: event.kind,
        title: event.title,
        ...(event.detail !== undefined && { detail: event.detail }),
        status: event.status,
        ...(event.payload !== undefined && { details: event.payload }),
      };
    case "usage":
      return {
        threadId,
        type: "usage",
        turnId,
        tokens: event.tokens,
        window: event.window,
      };
    case "turnUsage":
      return {
        threadId,
        type: "turnUsage",
        turnId,
        input: event.input,
        cached: event.cached,
        output: event.output,
        payload: event.payload,
      };
    case "turnEnded":
      return { threadId, type: "turnEnded", turnId, end: endOf(event.end) };
  }
}

/** The agent system, with each chat's Rufi AI on it. */
export async function startRufiAi(
  options: Omit<
    Parameters<typeof startAgents>[0],
    "host" | "live" | "apply" | "opened"
  > & {
    transcripts: Transcripts;
    /** Tells the person's documents screens that a sub-agent changed. */
    documents?: (personId: string) => void;
  },
): Promise<
  AgentSystem & {
    rufiAi: (host: RufiAiHost) => RufiAi;
    logs: AgentLogs;
    usage: () => Promise<ProviderUsage[]>;
  }
> {
  const { transcripts, adapters } = options;
  const kept = chatAgents(options.record, options.now);
  /** The chat, once it runs. */
  let chat: RufiAiHost | undefined;
  /** The rules' version each agent's conversation last opened with. */
  const given = new Map<string, string>();
  /** Each open conversation's agent, by its thread. */
  const threads = new Map<string, string>();
  /** The agent's events come from this thread from now on. */
  const follow = (agent: string, ref: string) => {
    for (const [thread, owner] of threads) {
      if (owner === agent) threads.delete(thread);
    }
    threads.set(ref, agent);
  };
  /** Rufi's own end for a turn it stopped, by the provider's turn. */
  const ends = new Map<string, TurnEnd>();
  let closed = false;

  /**
   * What the chat's sub-agents did, for the screens, once the system is up:
   * Rufi reads the package's events while it starts too.
   */
  const screens: { logs?: AgentLogs } = {};

  /** The agent's open conversation, by the provider's reference. */
  const threadOf = (agent: string) => {
    for (const [thread, owner] of threads) if (owner === agent) return thread;
    return undefined;
  };

  /** The chat whose agent `agent` is, as stored now. */
  const ownChat = async (agent: string) => {
    const owner = await kept.owner(agent);
    if (!owner) return undefined;
    const row = await transcripts.chat(owner.personId);
    return row?.id === owner.chatId ? { row, root: owner.root } : undefined;
  };

  /** The chat whose own agent, Rufi AI, `agent` is, as stored now. */
  const chatOf = async (agent: string) => {
    const owned = await ownChat(agent);
    return owned?.root ? owned.row : undefined;
  };

  const opening = async (
    agent: Agent,
    kind: "resume" | "new",
  ): Promise<Opening> => {
    const row = (await ownChat(agent.id))?.row;
    if (!row || !chat) throw new Error("Rufi AI's chat isn't open.");
    const parent =
      agent.parent === null ? undefined : system.agents.get(agent.parent);
    const now = await chat.opening(row, {
      id: agent.id,
      title: agent.title,
      tools: agent.tools,
      ...(parent && {
        parent: { title: parent.title, rufiAi: parent.parent === null },
      }),
    });
    given.set(agent.id, now.version);
    // A new conversation hears what came before: Rufi AI the chat, a
    // sub-agent its own turns, never the chat.
    const seed =
      kind === "new"
        ? agent.parent === null
          ? await now.seed()
          : ownSeed(agent.id)
        : undefined;
    return {
      instructions: now.instructions,
      tools: now.tools,
      ...(seed !== undefined && { seed }),
    };
  };

  /** A sub-agent's last turns, for its new conversation; none before its first. */
  const ownSeed = (agent: string): string | undefined => {
    const { turns } = system.agents.history(agent, { limit: SEED_TURNS });
    if (turns.length === 0) return undefined;
    const from = (sender: string) => {
      const found = system.agents.get(sender);
      return found ? `${found.title} (${found.id})` : sender;
    };
    const lines = turns.flatMap((turn) => [
      ...turn.inputs.map(
        (input) => `${from(input.sender)}: ${input.parts?.join("\n\n") ?? ""}`,
      ),
      `You${turn.status === "done" ? "" : ` (this turn ${turn.status})`}: ${turn.result ?? ""}`,
    ]);
    return `A new conversation started. Your earlier turns are available through read_agent with "self".\n\nYour last turns, oldest first:\n\n${lines.join("\n\n")}`;
  };

  // The package keeps out what an older conversation reports: what comes
  // is the agent's open conversation's.
  const live = (
    agent: string,
    ref: string,
    event: ProviderEvent,
    position?: number,
  ) => {
    if (threads.get(ref) !== agent) follow(agent, ref);
    // The chat shows Rufi AI's conversation; a sub-agent's is its own, and
    // the screens read it again.
    if (system.agents.get(agent)?.parent !== null) {
      screens.logs?.changed(agent);
      return;
    }
    if (event.type === "turnEnded") {
      const own = ends.get(event.turn);
      ends.delete(event.turn);
      if (own && event.end.status === "stopped") {
        chat?.onEvent({
          threadId: ref,
          type: "turnEnded",
          turnId: event.turn,
          end: own,
        });
        return;
      }
    }
    // The messages of its agents it took, with their own words.
    const messages =
      event.type === "turnStarted" ? system.agents.messages(event.inputs) : [];
    const started =
      event.type === "step"
        ? screens.logs?.started(agent, {
            type: "step",
            conversation: system.agents.get(agent)?.conversation ?? 0,
            id: event.item,
          })
        : undefined;
    if (started !== undefined) screens.logs?.changed(started);
    chat?.onEvent({
      ...eventOf(ref, event),
      ...(messages.length > 0 && { messages }),
      ...(position !== undefined && { position }),
      ...(started !== undefined && { agent: started }),
    });
  };

  // A root's turns and its chat's hand-overs from the package's events,
  // after what the chat was told was saved: a turn's start when the chat
  // didn't save it, with the rows it took sent; the record of its whole
  // answer, and its end when the chat didn't save it; and what became of
  // each row the package handed over (transcripts.applyStart, applyEnd,
  // applyInput).
  const apply: Apply = async (event, advance) => {
    // Whatever a sub-agent's change, its chat's screens read it again.
    if (event.agent !== null) screens.logs?.changed(event.agent);
    if (event.agent === null || !APPLIED.has(event.type)) return false;
    const row = await chatOf(event.agent);
    if (!row) return false;
    await chat?.saved();
    const payload = event.payload as {
      input: string;
      ref?: string | null;
      /** From another agent: what it is. */
      message?: AgentMessage;
      held: Hold;
      text: string;
    };
    switch (event.type) {
      case "turn.started": {
        const { ref, inputs, messages } = event.payload as {
          ref: string;
          inputs: string[];
          messages?: AgentMessage[];
        };
        await transcripts.applyStart(
          row,
          ref,
          { id: row.threadId ?? "", model: row.model ?? row.threadModel ?? "" },
          inputs,
          messages ?? [],
          advance,
        );
        break;
      }
      case "turn.ended": {
        const { ref, item, ...end } = event.payload as Ended & {
          ref: string;
          item?: string;
        };
        await transcripts.applyEnd(
          row,
          ref,
          endOf(end),
          end.status === "done"
            ? { text: end.answer, ...(item !== undefined && { item }) }
            : undefined,
          advance,
        );
        break;
      }
      case "input.delivered": {
        // One of its agents' messages, steered into its turn, shows there.
        const { message } = payload;
        await (message
          ? transcripts.applyAgentMessage(
              row,
              message,
              payload.ref ?? null,
              advance,
            )
          : transcripts.applyInput(
              row,
              payload.input,
              { state: "delivered", agentTurn: payload.ref ?? null },
              advance,
            ));
        break;
      }
      case "input.held":
        await transcripts.applyInput(
          row,
          payload.input,
          { state: "held", ...holdOf(payload.held, payload.text) },
          advance,
        );
        break;
      case "input.waiting":
        await transcripts.applyInput(
          row,
          payload.input,
          { state: "waiting" },
          advance,
        );
        break;
      case "input.released":
        await transcripts.applyInput(
          row,
          payload.input,
          { state: "released" },
          advance,
        );
    }
    chat?.changed(row);
    return true;
  };

  const system = await startAgents({
    ...options,
    host: {
      opening,
      claim: async ({ agent, conversation, input }) => {
        // Rufi closing: the row stays for the next start.
        if (closed || !chat) return undefined;
        const row = await chatOf(agent);
        if (!row) return { status: "gone" };
        return chat.claim(row, input, sentAs(agent, conversation));
      },
    },
    live,
    apply,
    // A root's new conversation is its chat's thread from now on.
    opened: async ({ agent, provider, ref }) => {
      const row = await chatOf(agent);
      if (!row) return;
      // Once the pointer moves, the old thread's events can't find the
      // chat: they are saved first.
      await chat?.saved();
      await transcripts.setThread(row, {
        id: ref,
        provider,
        model: system.agents.get(agent)?.model ?? "",
        tools: given.get(agent) ?? "",
      });
      follow(agent, ref);
    },
  });
  const { agents } = system;
  // A message Rufi claimed that the agent database doesn't hold (a new one)
  // counts as sent: it enters its chat in a reply, which Rufi's start then
  // shows stopped (core.ts).
  for (const claim of await kept.claimed()) {
    if (agents.input(claim.id) !== undefined) continue;
    const row = await transcripts.chat(claim.personId);
    if (row?.id !== claim.chatId) continue;
    await transcripts.startTurn(
      row,
      claim.id,
      { id: row.threadId ?? "", model: row.model ?? row.threadModel ?? "" },
      [claim.id],
    );
  }
  const shown = agentLogs({ agents, kept, documents: options.documents });
  screens.logs = shown;
  // A chat's replies' steps show from the agent database, by its own agent;
  // a step that started a sub-agent names it.
  transcripts.readSteps({
    of: (agent, agentTurns) => {
      const found = new Map<string, Step[]>(
        agents.known(agent, agentTurns).map((turn) => [turn, []]),
      );
      for (const item of agents.items(agent, agentTurns)) {
        const child = shown.started(agent, item);
        const turn = found.get(item.turn) ?? [];
        turn.push(child === undefined ? item : { ...item, agent: child });
        found.set(item.turn, turn);
      }
      return found;
    },
    details: (agent, agentTurn, id) => {
      const found = agents.item(agent, agentTurn, id);
      return found && { details: found.payload };
    },
  });

  /** Every provider's models now; one that can't say is left out, unless all fail. */
  const models = async (signal?: AbortSignal): Promise<OfferedModel[]> => {
    const settled = await Promise.allSettled(
      adapters.map(async (adapter) =>
        (await adapter.models(signal)).map(
          ({ id, name, efforts, defaultEffort }) => ({
            id,
            name,
            provider: adapter.id,
            efforts,
            ...(defaultEffort !== undefined && { defaultEffort }),
          }),
        ),
      ),
    );
    const failed = settled.find((one) => one.status === "rejected");
    if (failed && settled.every((one) => one.status === "rejected")) {
      throw failed.reason;
    }
    const offered = settled.flatMap((one) =>
      one.status === "fulfilled" ? one.value : [],
    );
    return offered;
  };

  const rufiAi = (host: RufiAiHost): RufiAi => {
    chat = host;
    closed = false;
    const provider = adapters[0]?.id ?? "";
    return {
      provider,

      models,

      configure: async (row) => {
        const agent = await system.root(row.id);
        const now = agents.get(agent);
        if (!now) return;
        // Rufi AI runs on its model's provider, kept with the choice, also
        // when it was made anew on another; never on another one's.
        if (row.model !== null && row.modelProvider === null) {
          throw new Error(UNKNOWN_PROVIDER);
        }
        agents.configure(agent, {
          ...(row.modelProvider !== null && { provider: row.modelProvider }),
          model: row.model ?? now.model,
          effort: row.effort,
        });
      },

      reopen: async (row, fresh) => {
        const agent = await system.root(row.id);
        await agents.reopen(agent, fresh);
        given.delete(agent);
      },

      rules: async (row) => given.get(await system.root(row.id)),

      busy: async (row) =>
        agents.current(await system.root(row.id)) !== undefined,

      running: (threadId) => {
        const agent = threads.get(threadId);
        return agent !== undefined && agents.current(agent) !== undefined;
      },

      activeTurn: (threadId) => {
        const agent = threads.get(threadId);
        const current = agent === undefined ? undefined : agents.current(agent);
        return current?.status === "running" ? current.ref : undefined;
      },

      place: async (agent, meta) => {
        const placed = agents.place(agent, meta);
        if (!placed) return undefined;
        // Whose the agent is, as Rufi keeps it now: a call of an agent Rufi
        // no longer owns, or of another chat's, finds nothing.
        const owner = await kept.owner(agent);
        const row = owner && (await transcripts.chat(owner.personId));
        const found = agents.get(agent);
        const thread = threadOf(agent);
        if (row?.id !== owner?.chatId || !row || !found || !thread) {
          return undefined;
        }
        return {
          chat: row,
          agent,
          thread,
          conversation: placed.conversation,
          turn: placed.turn,
          ref: placed.ref,
          call: placed.call,
          tools: found.tools,
          ...(found.parent !== null && { label: found.title }),
        };
      },

      queue: async (row, rows, order) => {
        const agent = await system.root(row.id);
        for (const { id, sender, kind } of rows) {
          agents.send(agent, {
            id,
            sender,
            kind,
            ...(sender === "person" && { person: true as const }),
          });
        }
        agents.reorder(agent, order);
      },

      input: (input) => agents.input(input),

      remove: (inputs) => {
        agents.remove(inputs);
      },

      steer: (input) => {
        agents.steer(input);
      },

      release: (inputs) => {
        agents.release(inputs);
      },

      stop: async (row) => {
        await agents.stop(await system.root(row.id), "person");
      },

      cut: async (threadId, turnId, end) => {
        const agent = threads.get(threadId);
        if (agent === undefined) return;
        const current = agents.current(agent);
        const ref = current?.status === "starting" ? undefined : current?.ref;
        if (ref !== turnId) return;
        if (end) ends.set(ref, end);
        await agents.stop(agent, "rufi");
      },

      // What waits stays in the chat's queue for the next start.
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  };

  return {
    ...system,
    rufiAi,
    logs: shown,
    usage: () =>
      Promise.all(
        adapters.map(async (adapter) => ({
          provider: adapter.id,
          windows: await adapter.usage(),
        })),
      ),
    close: async () => {
      shown.close();
      await system.close();
      const failed: unknown[] = [];
      for (const adapter of adapters) {
        try {
          await adapter.close();
        } catch (error) {
          failed.push(error);
        }
      }
      if (failed.length > 0) {
        throw new AggregateError(
          failed,
          `Some providers didn't close: ${failed.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
        );
      }
    },
  };
}
