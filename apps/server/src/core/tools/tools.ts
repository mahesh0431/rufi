// Every Rufi tool, for the agent and the screens. What the AI is told about
// using them is in the core (core/chat/instructions.ts) and the skills.
import {
  agentStatus,
  listModels,
  readAgent,
  sendAgent,
  setAgentModel,
  startAgent,
  stopAgent,
  usage,
  waitingMessages,
} from "./agents.ts";
import { briefResult, createBrief } from "./brief.ts";
import { readChat } from "./chat.ts";
import { getDocuments, sortDocuments } from "./documents.ts";
import { showFace } from "./face.ts";
import { getOverview } from "./overview.ts";
import {
  dismissedResult,
  dismissItems,
  savedResult,
  saveChanges,
} from "./save.ts";
import { getRecords } from "./records.ts";
import {
  answerOf,
  type AgentTools,
  inputSchema,
  Refusal,
  specOf,
  toolCaller,
  type Tool,
  type ToolAnswer,
  type ToolContext,
} from "./registry.ts";
import type { Transaction } from "kysely";
import type { Log } from "../../platform/logs.ts";
import type { ChatRow, ToolCall, Transcripts } from "../chat/transcript.ts";
import { createBrief as makeBrief } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
import type { SortAnswer, SortInput, SortScope } from "../documents/sorting.ts";
import { dismissItems as dismissDrafts } from "../record/items.ts";
import { saveChanges as saveToRecord } from "../record/save.ts";
import type { Store } from "../store/database.ts";
import type { Tables } from "../store/tables.ts";

export const TOOLS: readonly Tool[] = [
  getOverview,
  getRecords,
  getDocuments,
  readChat,
  saveChanges,
  dismissItems,
  sortDocuments,
  createBrief,
  showFace,
  startAgent,
  agentStatus,
  sendAgent,
  readAgent,
  stopAgent,
  waitingMessages,
  listModels,
  setAgentModel,
  usage,
];

/**
 * The name the agent knows Rufi's MCP server by: on a code-mode model the AI
 * calls `tools.mcp__rufi__get_overview`. tools.json names them rufi.<tool>.
 */
const SERVER = "rufi";

/** The model's tools: their catalog for the MCP server, and their caller. */
export function forAgent(
  context: () => ToolContext,
  log: Log,
  /** The agent's own tools, by name; all of them when not given. */
  names?: readonly string[],
) {
  const tools = TOOLS.filter(
    (tool) =>
      tool.callers !== "ui" &&
      (names === undefined || names.includes(tool.name)),
  );
  return {
    server: SERVER,
    specs: tools.map(specOf),
    call: toolCaller(tools, context, log),
  };
}

/** tools.json: every tool as documentation, generated (pnpm tools:json). */
export function toolsJson(): string {
  const tools = TOOLS.map((tool) => ({
    name: `${SERVER}.${tool.name}`,
    description: tool.description,
    callers: tool.callers,
    readOnly: tool.readOnly,
    destructive: tool.destructive,
    inputSchema: inputSchema(tool),
    examples: tool.examples,
  }));
  return `${JSON.stringify({ tools }, null, 2)}\n`;
}

/** What a call to Rufi's tools runs with, as the door placed it (server/door.ts). */
export interface CallScope {
  /** Whose the agent is: its chat. */
  chat: ChatRow;
  agent: string;
  /** The agent's conversation: the provider's reference, and its number. */
  thread: string;
  conversation: number;
  /** The agent's turn: in the agent database, and as the provider names it. */
  turn: string;
  ref: string;
  /** Rufi's id for the call: `<agent>/<conversation>/<provider call id>`. */
  callId: string;
  /** Rufi's tools the agent may use. */
  tools: readonly string[];
  /** A sub-agent's title, which its lines in the chat name; none for Rufi AI. */
  label?: string;
}

/** What every call of one turn runs with. */
export type TurnScope = Omit<CallScope, "callId">;

/**
 * The one Rufi caller, for an agent's turn, from the scope the door placed
 * its calls in; each call gives Rufi's id for it: the agent's own tools, in its chat, the one place
 * the AI can save, sort or make a brief. Each is written with its line in
 * the chat.
 */
export function rufiCaller(
  reader: Store | undefined,
  transcripts: Transcripts,
  log: Log,
  pages?: Pages,
  sort?: {
    run: (
      scope: SortScope,
      input: SortInput,
      trx: Transaction<Tables>,
    ) => Promise<SortAnswer>;
    /** After a sort is kept. */
    done: (personId: string) => void;
  },
  /** The calling agent's agents, from its scope (server/sub-agents.ts). */
  agents?: (scope: TurnScope) => AgentTools,
) {
  return (scope: TurnScope) => {
    const { chat, ref } = scope;
    const below = agents?.(scope);
    const call = forAgent(
      () => ({
        store: reader,
        personId: chat.personId,
        chatId: chat.id,
        pages,
        agents: below,
      }),
      log,
      scope.tools,
    ).call;
    /**
     * The writes of one call: each commits with its receipt or line and
     * the call with the answer the AI gets, in one transaction, then
     * `kept` says so.
     */
    const writes = (made: ToolCall, kept: () => void): Partial<ToolContext> => {
      return {
        save: async (input, callId) => {
          const saved = await transcripts.saveWithReceipt(
            chat,
            made,
            (trx, at, refs, turnId) =>
              saveToRecord(
                trx,
                {
                  personId: chat.personId,
                  chatId: chat.id,
                  turnId,
                  callId,
                  now: at,
                  refs,
                },
                input,
              ),
            (done) => answerOf(savedResult(done)),
          );
          kept();
          return saved;
        },
        dismiss: async (input, callId) => {
          const dismissed = await transcripts.saveWithReceipt(
            chat,
            made,
            (trx, _at, refs) =>
              dismissDrafts(
                trx,
                { personId: chat.personId, callId, refs },
                input,
              ),
            (done) => answerOf(dismissedResult(done)),
          );
          kept();
          return dismissed;
        },
        sort: async (input, callId) => {
          if (!sort) throw new Refusal("Rufi can't sort documents here.");
          const sorted = await transcripts.withToolCall(
            chat,
            made,
            (trx) =>
              sort.run(
                {
                  personId: chat.personId,
                  chatId: chat.id,
                  agentTurnId: ref,
                  callId,
                },
                input,
                trx,
              ),
            answerOf,
          );
          kept();
          sort.done(chat.personId);
          return sorted;
        },
        brief: async (input, callId) => {
          const written = await transcripts.briefWithLine(
            chat,
            made,
            (trx, at, turnId) =>
              makeBrief(
                trx,
                {
                  personId: chat.personId,
                  chatId: chat.id,
                  turnId,
                  callId,
                  now: at,
                },
                input,
              ),
            (done) => answerOf(briefResult(done)),
          );
          kept();
          return written;
        },
      };
    };
    return async (
      name: string,
      input: unknown,
      callId: string,
    ): Promise<ToolAnswer> => {
      const own = { kept: false };
      const answer = await call(
        name,
        input,
        callId,
        writes(
          {
            agent: scope.agent,
            agentTurn: scope.turn,
            ref,
            callId,
            tool: name,
            input,
            startedAt: transcripts.now(),
            ...(scope.label !== undefined && { label: scope.label }),
          },
          () => {
            own.kept = true;
          },
        ),
      );
      return own.kept ? { ...answer, kept: true } : answer;
    };
  };
}
