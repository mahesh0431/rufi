// Every Rufi tool, for the agent and the screens. What the AI is told about
// using them is in the core (core/chat/instructions.ts) and the skills.
import { createBrief } from "./brief.ts";
import { readChat } from "./chat.ts";
import { getDocuments, saveReading, sortDocuments } from "./documents.ts";
import { showFace } from "./face.ts";
import { getOverview } from "./overview.ts";
import { dismissItems, saveChanges } from "./save.ts";
import { getRecords } from "./records.ts";
import {
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
import type { ChatRow, Transcripts } from "../chat/transcript.ts";
import { createBrief as makeBrief } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
import {
  keptReading,
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
) {
  const tools = TOOLS.filter((tool) => tool.callers !== "ui");
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

/**
 * What Rufi keeps of a call's input: as it came, but for a reading's page
 * text, which goes with its document (save-reading.ts).
 */
export function keptInput(tool: string, input: unknown): unknown {
  return tool === saveReading.name ? keptReading(input) : input;
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

/**
 * The tools of one turn in Rufi's own chat, the one place the AI can save,
 * sort or make a brief: each is written with its line in the chat. A turn a
 * Rufi event started can only read: the person didn't ask for it.
 */
export function chatCaller(
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
  return (chat: ChatRow, agentTurnId: string, origin: "person" | "rufi") => {
    // Sorts and readings kept with their call, by call id, till their
    // answer goes out.
    const kept = new Set<string>();
    const call = forAgent(
      () => ({
        store: reader,
        personId: chat.personId,
        chatId: chat.id,
        pages,
        save: (input, callId) =>
          origin === "rufi"
            ? Promise.reject(new Refusal(EVENT_TURN))
            : transcripts.saveWithReceipt(
                chat,
                agentTurnId,
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
              ),
        dismiss: (input, callId) =>
          origin === "rufi"
            ? Promise.reject(new Refusal(EVENT_TURN))
            : transcripts.saveWithReceipt(chat, agentTurnId, (trx, _at, refs) =>
                dismissDrafts(
                  trx,
                  { personId: chat.personId, callId, refs },
                  input,
                ),
              ),
        // In the sort's transaction, which keeps the call too.
        sort: async (input, callId) => {
          if (origin === "rufi") throw new Refusal(EVENT_TURN);
          if (!sort) throw new Refusal("Rufi can't sort documents here.");
          const sorted = await transcripts.withToolCall(
            chat,
            agentTurnId,
            { callId, tool: "sort_documents", input },
            (trx) =>
              sort.run(
                {
                  personId: chat.personId,
                  chatId: chat.id,
                  agentTurnId,
                  callId,
                },
                input,
                trx,
              ),
          );
          kept.add(callId);
          sort.done(chat.personId);
          return sorted;
        },
        // In the reading's transaction too, kept without its page text.
        saveReading: async (input, callId) => {
          if (origin === "rufi") throw new Refusal(EVENT_TURN);
          if (!reading) throw new Refusal("Rufi can't save a reading here.");
          const saved = await transcripts.withToolCall(
            chat,
            agentTurnId,
            { callId, tool: saveReading.name, input: keptReading(input) },
            (trx) =>
              reading.run(
                { personId: chat.personId, chatId: chat.id, callId },
                input,
                trx,
              ),
          );
          kept.add(callId);
          reading.done(chat.personId);
          return saved;
        },
        brief: (input, callId) =>
          origin === "rufi"
            ? Promise.reject(new Refusal(EVENT_TURN))
            : transcripts.briefWithLine(chat, agentTurnId, (trx, at, turnId) =>
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
              ),
      }),
      log,
      () => rejectionsPerReply(transcripts.setting),
    ).forTurn();
    return async (
      name: string,
      input: unknown,
      callId?: string,
    ): Promise<ToolAnswer> => {
      const answer = await call(name, input, callId);
      return callId !== undefined && kept.delete(callId)
        ? { ...answer, kept: true }
        : answer;
    };
  };
}
