// Rufi's agent tools: an agent starts agents of its own, sees how the ones
// below it are, writes to one or to the agent that started it, reads the
// conversation of any agent in its chat, stops one below it or itself,
// with or without everything under it, manages what waits for it and for
// the agents below it, and moves an agent below it to another of Rufi's
// four models, which their schema names. Rufi's chat does them in the agent
// system (server/sub-agents.ts); a sub-agent gets the tools of the agent
// that starts it.
import { Effort, MODELS, ModelId } from "@rufi/contracts";
import { Schema } from "effect";
import { defineTool, NoInput, Refusal } from "./registry.ts";

/** Rufi's four models, by id and name, for the tools' descriptions. */
const MODEL_NAMES = MODELS.map(({ id, name }) => `${id} (${name})`).join(", ");

export const StartAgentInput = Schema.Struct({
  title: Schema.String.annotate({
    description:
      'What the agent is for, in a few words, as the user would see it: "Reading report.pdf".',
  }).check(Schema.isMinLength(1)),
  task: Schema.String.annotate({
    description:
      "Its whole task, its first message: it sees nothing of your conversation but this.",
  }).check(Schema.isMinLength(1)),
  model: Schema.optionalKey(
    ModelId.annotate({
      description: `One of Rufi's models: ${MODEL_NAMES}. Leave it out for yours.`,
    }),
  ),
  effort: Schema.optionalKey(
    Effort.annotate({
      description:
        "How hard it thinks: low is fastest, xhigh thinks longest. Leave it out for yours.",
    }),
  ),
});
export type StartAgentInput = typeof StartAgentInput.Type;

export const SetAgentModelInput = Schema.Struct({
  agent: Schema.String.annotate({
    description: "An agent below you, by id.",
  }).check(Schema.isMinLength(1)),
  model: ModelId.annotate({
    description: `One of Rufi's models: ${MODEL_NAMES}.`,
  }),
  effort: Schema.optionalKey(
    Effort.annotate({
      description:
        "How hard it thinks: low is fastest, xhigh thinks longest. Leave it out to keep the agent's.",
    }),
  ),
});
export type SetAgentModelInput = typeof SetAgentModelInput.Type;

export const AgentStatusInput = Schema.Struct({
  agents: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "The agents, by id. Leave it out for every agent below you.",
    }),
  ),
});
export type AgentStatusInput = typeof AgentStatusInput.Type;

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
    description: 'An agent in your chat, by id, or "self".',
  }).check(Schema.isMinLength(1)),
  before: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The `earlier` of the page you read, for the turns before it.",
    }),
  ),
});
export type ReadAgentInput = typeof ReadAgentInput.Type;

export const StopAgentInput = Schema.Struct({
  agent: Schema.String.annotate({
    description: 'An agent below you, by id, or "self".',
  }).check(Schema.isMinLength(1)),
  with_children: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "true: every agent below it stops too, and what waits for any of them is dropped. Leave it out to stop just this agent.",
    }),
  ),
});
export type StopAgentInput = typeof StopAgentInput.Type;

export const WaitingMessagesInput = Schema.Struct({
  action: Schema.Literals([
    "list",
    "edit",
    "remove",
    "reorder",
    "steer",
  ]).annotate({
    description:
      "list: what waits for you and for the agents below you, in the order it goes. edit: new text for one (id, text). remove: one never goes (id). reorder: one agent's messages in this order (ids). steer: one goes now, into its agent's running turn or first in line, also one held (id).",
  }),
  id: Schema.optionalKey(
    Schema.String.annotate({
      description: "The message, as list gives it: for edit, remove and steer.",
    }),
  ),
  text: Schema.optionalKey(
    Schema.String.annotate({
      description: "Its new text, whole: for edit.",
    }).check(Schema.isMinLength(1)),
  ),
  ids: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Messages of one agent, in the order they go: for reorder. The others keep their places.",
    }),
  ),
});
export type WaitingMessagesInput = typeof WaitingMessagesInput.Type;

const outside = () =>
  new Refusal("Agents can be started only by an agent in Rufi's chat.");

export const startAgent = defineTool({
  name: "start_agent",
  description:
    "Starts an agent of your own for a task that can run on its own: it runs at once, on your model and effort unless you give others (a model whose provider isn't signed in is refused, yours too), and goes on after your turn ends. Give it a title and its whole task, its first message. It has all of your tools. Its saves and briefs show in the chat with Rufi's receipt. Answers its id; agent_status says how it is, and read_agent reads its conversation.",
  input: StartAgentInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [
    {
      title: "Checking the thyroid results",
      task: "Read the user's thyroid results with get_records and say which are outside the lab's range.",
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
    "How the agents below you are: the ones you started and theirs, each with its title, the agent that started it (self: you), its model and effort, its status (idle before its first turn, running, done, stopped or failed) and its latest result. An id that isn't below you is not found. It doesn't wait.",
  input: AgentStatusInput,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{}],
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.status(input);
  },
});

export const sendAgent = defineTool({
  name: "send_agent",
  description:
    'Writes to an agent below you, or to the agent that started you ("parent"): a question, feedback, more to do, anything. It gets your words with your title, and an idle one starts a turn for it. Answers steered, queued or will start the next turn; it is never refused for being busy. An agent you started sends you its answer by itself when its turn ends; one further below sends its answer to the agent that started it. To answer an agent you started, write to it by its id: your own answer at the end of your turn doesn\'t go to it.',
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
    "Reads the conversation of an agent in your chat, yours (\"self\") or another's: its turns, the latest page first, each with what it was sent and by whom, its steps, the questions it asked (with their options), its result and what it used, once it ended (the tokens it read, how many of those from the cache, and the tokens it wrote, as its provider counted them). Give before: the page's earlier for the page before it; earlier is null on the first page. An agent outside your chat is not found.",
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

export const stopAgent = defineTool({
  name: "stop_agent",
  description:
    'Stops an agent below you, or yourself ("self"): its turn ends now, and what it was given to do next goes on after. With with_children, every agent below it stops too, what waits for any of them is dropped (the user\'s messages show "Not sent" with Send), and none of their results wakes another; the stopped agent\'s own result goes to the agent that started it. Answers the agents that stop; agent_status says when they have.',
  input: StopAgentInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [{ agent: "self", with_children: true }],
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.stop(input);
  },
});

export const waitingMessages = defineTool({
  name: "waiting_messages",
  description:
    "Manages the messages waiting for you and for the agents below you: the user's, Rufi's notes and agents' messages. list gives each with its id, whose queue it is in (self: yours), who sent it, steer or queue, its text, and why it is held, if it is (one held goes only when it is steered). edit gives one new text; remove means it never goes; reorder puts the messages given, of one queue, in that order, in the places they had; steer sends one now, into its agent's running turn or first in line, and lifts its hold. Every action answers the list as it is then. The user's messages change as if the user changed them: one already on its way can't be changed.",
  input: WaitingMessagesInput,
  callers: "model",
  readOnly: false,
  destructive: true,
  examples: [{ action: "list" }, { action: "steer", id: "<id from list>" }],
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.waiting(input);
  },
});

export const usage = defineTool({
  name: "usage",
  description:
    "How much of the user's plan is used now, for each provider (yours names the one your model runs on), as the provider last reported it: each usage window with its length in minutes, the percent used and when it resets. A provider reports it as its replies run, so a provider with no reply yet since Rufi started has no windows.",
  input: NoInput,
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{}],
  run: (_input, { agents }) => {
    if (!agents) throw outside();
    return agents.usage();
  },
});

export const setAgentModel = defineTool({
  name: "set_agent_model",
  description:
    "Changes the model of an agent below you, and its effort if you give one, from its next turn on: never your own. Only while the agent isn't running: wait for its turn to end. On another provider's model, its next turn starts a new conversation there, which hears its last 10 turns. Answers the agent with its model and effort.",
  input: SetAgentModelInput,
  callers: "model",
  readOnly: false,
  destructive: false,
  examples: [{ agent: "<id from agent_status>", model: "claude-opus-5-5" }],
  run: (input, { agents }) => {
    if (!agents) throw outside();
    return agents.setModel(input);
  },
});
