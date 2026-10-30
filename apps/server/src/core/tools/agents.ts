// Rufi's agent tools: an agent starts agents of its own, sees how the ones
// below it are and waits for one, writes to one or to the agent that started
// it, and reads its own conversation or one below it. Rufi's chat does them
// in the agent system (server/sub-agents.ts); a sub-agent never gets more
// tools than the agent that starts it.
import { Schema } from "effect";
import { defineTool, Refusal } from "./registry.ts";

export const StartAgentInput = Schema.Struct({
  title: Schema.String.annotate({
    description:
      'What the agent is for, in a few words, as the user would see it: "Reading report.pdf".',
  }).check(Schema.isMinLength(1)),
  task: Schema.String.annotate({
    description:
      "Its whole task, its first message: it sees nothing of your conversation but this.",
  }).check(Schema.isMinLength(1)),
  tools: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Rufi's tools it may use, by name, among your own. Leave it out for all of yours.",
    }),
  ),
});
export type StartAgentInput = typeof StartAgentInput.Type;

/** The longest wait, in minutes: 24 hours. */
export const WAIT_MAX = 24 * 60;

/** A wait's length in minutes when the agent gives none: an hour. */
const WAIT_DEFAULT = 60;

export const AgentStatusInput = Schema.Struct({
  agents: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "The agents, by id. Leave it out for every agent below you.",
    }),
  ),
  wait: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean,
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WAIT_MAX })),
    ]).annotate({
      description: `Wait until one of them ends a turn: true for at most an hour, or at most this many minutes, 1 to ${String(WAIT_MAX)}. Leave it out not to wait.`,
    }),
  ),
});
export type AgentStatusInput = typeof AgentStatusInput.Type;

/** How long a call asks to wait, in ms; 0 when it doesn't, or isn't valid. */
export function waitMs(input: unknown): number {
  const wait = (input as { wait?: unknown } | null)?.wait;
  if (wait === true) return WAIT_DEFAULT * 60_000;
  return typeof wait === "number" &&
    Number.isInteger(wait) &&
    wait >= 1 &&
    wait <= WAIT_MAX
    ? wait * 60_000
    : 0;
}

export const SendAgentInput = Schema.Struct({
  to: Schema.String.annotate({
    description:
      'An agent below you, by id, or "parent": the agent that started you.',
  }).check(Schema.isMinLength(1)),
  text: Schema.String.annotate({
    description: "What you tell or ask it, whole: it sees only this.",
  }).check(Schema.isMinLength(1)),
  kind: Schema.optionalKey(
    Schema.Literals(["steer", "queue"]).annotate({
      description:
        "steer (the default): into its turn as soon as it can take it, or it starts one; queue: after its turn ends.",
    }),
  ),
});
export type SendAgentInput = typeof SendAgentInput.Type;

export const ReadAgentInput = Schema.Struct({
  agent: Schema.String.annotate({
    description: 'An agent below you, by id, or "self".',
  }).check(Schema.isMinLength(1)),
  before: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The `earlier` of the page you read, for the turns before it.",
    }),
  ),
});
export type ReadAgentInput = typeof ReadAgentInput.Type;

const outside = () =>
  new Refusal("Agents can be started only by an agent in Rufi's chat.");

export const startAgent = defineTool({
  name: "start_agent",
  description:
    "Starts an agent of your own for a task that can run on its own: it runs at once, on your model and effort, and goes on after your turn ends. Give it a title and its whole task, its first message. It has your tools unless you give it fewer (tools); one you don't have is refused. Its saves and briefs show in the chat with Rufi's receipt. Answers its id; agent_status says how it is, and read_agent reads its conversation.",
  input: StartAgentInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      title: "Checking the thyroid results",
      task: "Read the user's thyroid results with get_records and say which are outside the lab's range.",
      tools: ["get_overview", "get_records"],
    },
  ],
  run: (input, { agents, callId }) => {
    if (!agents || callId === undefined) throw outside();
    return agents.start(input, callId);
  },
});

export const agentStatus = defineTool({
  name: "agent_status",
  description:
    "How the agents below you are: the ones you started and theirs, each with its title, the agent that started it (self: you), its status (idle before its first turn, running, done, stopped or failed) and its latest result. An id that isn't below you is not found. With wait, it first waits until one of them ends a turn (ended: its id), or the wait runs out, or your turn ends (ended: null); running out never stops an agent. A result it gives you this way doesn't come to you again as a message.",
  input: AgentStatusInput,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{}, { agents: ["<an agent's id>"], wait: 10 }],
  waitsMs: waitMs,
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.status(input);
  },
});

export const sendAgent = defineTool({
  name: "send_agent",
  description:
    'Writes to an agent below you, or to the agent that started you ("parent"): a question, feedback, more to do, anything. It gets your words with your title, and an idle one starts a turn for it. Answers steered, queued or will start the next turn; it is never refused for being busy. An agent\'s answer comes back to you as a message from it when its turn ends.',
  input: SendAgentInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    { to: "parent", text: "Page 3 is cut off. Shall I read the rest?" },
  ],
  run: (input, { agents, callId }) => {
    if (!agents || callId === undefined) throw outside();
    return agents.send(input, callId);
  },
});

export const readAgent = defineTool({
  name: "read_agent",
  description:
    "Reads an agent's conversation, yours (\"self\") or one below you: its turns, the latest page first, each with what it was sent and by whom, its steps, the questions it asked (with their options) and its result. Give before: the page's earlier for the page before it; earlier is null on the first page. An agent that isn't you or below you is not found.",
  input: ReadAgentInput,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{ agent: "self" }],
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.read(input);
  },
});
