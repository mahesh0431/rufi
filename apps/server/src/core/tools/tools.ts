// Every Rufi tool, for the agent and the screens. What the AI is told about
// using them is in the core (core/chat/instructions.ts) and the skills.
import { briefResult, createBrief } from "./brief.ts";
import { readChat } from "./chat.ts";
import { getDocuments, saveReading, sortDocuments } from "./documents.ts";
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
  inputSchema,
  REJECTIONS_PER_TURN,
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
import {
  keptReading,
  keptUnsaved,
  type SaveReadingAnswer,
  type SaveReadingInput,
  type SaveReadingScope,
} from "../documents/save-reading.ts";
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
  saveReading,
  createBrief,
  showFace,
];

/**
 * The name the agent knows Rufi's MCP server by: on a code-mode model the AI
 * calls `tools.mcp__rufi__get_overview`. tools.json names them rufi.<tool>.
 */
const SERVER = "rufi";

/** Why a Rufi event's turn can't save, sort or make a brief. */
const EVENT_TURN =
  "This turn was started by a Rufi event, not by the user, so nothing can be saved, sorted or made in it. Explain or ask; the user asks in a message of their own.";

/**
 * The model's tools: their catalog for the MCP server, and a caller per
 * turn, which ends the turn after `rejections` refused calls.
 */
export function forAgent(
  context: () => ToolContext,
  log: Log,
  rejections?: () => Promise<number>,
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
    forTurn: () => toolCaller(tools, context, log, rejections),
  };
}

/**
 * The setting for how many refused calls end a reply in Rufi's chat: a
 * whole number above 0, else REJECTIONS_PER_TURN. A limit on loops, not a
 * rule about health data; it isn't on the Settings screen.
 */
export const REJECTIONS_SETTING = "rejections_per_reply";

async function rejectionsPerReply(
  setting: (key: string) => Promise<string | undefined>,
): Promise<number> {
  const value = Number(await setting(REJECTIONS_SETTING));
  return Number.isInteger(value) && value > 0 ? value : REJECTIONS_PER_TURN;
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
}

/** What every call of one turn runs with. */
export type TurnScope = Omit<CallScope, "callId">;

/**
 * The one Rufi caller, for an agent's turn, from the scope the door placed
 * its calls in; each call gives Rufi's id for it: the agent's own tools, in its chat, the one place
 * the AI can save, sort or make a brief. Each is written with its line in
 * the chat. A turn a Rufi event started can only read: the person didn't
 * ask for it.
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
  reading?: {
    run: (
      scope: SaveReadingScope,
      input: SaveReadingInput,
      trx: Transaction<Tables>,
    ) => Promise<SaveReadingAnswer>;
    /** After a reading is kept. */
    done: (personId: string) => void;
  },
) {
  return (scope: TurnScope, origin: "person" | "rufi") => {
    const { chat, ref } = scope;
    const call = forAgent(
      () => ({
        store: reader,
        personId: chat.personId,
        chatId: chat.id,
        pages,
      }),
      log,
      () => rejectionsPerReply(transcripts.setting),
      scope.tools,
    ).forTurn();
    /**
     * The writes of one call: each commits with its receipt or line and
     * the call with the answer the AI gets, in one transaction, then
     * `kept` says so.
     */
    const writes = (made: ToolCall, kept: () => void): Partial<ToolContext> => {
      // A turn a Rufi event started writes nothing.
      const mayWrite = () => {
        if (origin === "rufi") throw new Refusal(EVENT_TURN);
      };
      return {
        save: async (input, callId) => {
          mayWrite();
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
          mayWrite();
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
          mayWrite();
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
        // Kept without its page text: that goes with its document.
        saveReading: async (input, callId) => {
          mayWrite();
          if (!reading) throw new Refusal("Rufi can't save a reading here.");
          const saved = await transcripts.withToolCall(
            chat,
            { ...made, input: keptReading(input, true) },
            (trx) =>
              reading.run(
                { personId: chat.personId, chatId: chat.id, callId },
                input,
                trx,
              ),
            answerOf,
          );
          kept();
          reading.done(chat.personId);
          return saved;
        },
        brief: async (input, callId) => {
          mayWrite();
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
          },
          () => {
            own.kept = true;
          },
        ),
      );
      if (own.kept) return { ...answer, kept: true };
      // A reading not saved is kept without its page text too.
      return name === saveReading.name
        ? {
            ...answer,
            keep: await keptUnsaved(reader, chat.personId, input, answer),
          }
        : answer;
    };
  };
}
