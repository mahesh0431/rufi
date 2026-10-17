// Every Rufi tool, for the agent and the screens. What the AI is told about
// using them is in the core (core/chat/instructions.ts) and the skills.
import { createBrief } from "./brief.ts";
import { readChat } from "./chat.ts";
import { getDocuments, retryReading, sortDocuments } from "./documents.ts";
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
  type ToolContext,
} from "./registry.ts";
import type { Log } from "../../platform/logs.ts";
import type { ChatRow, Transcripts } from "../chat/transcript.ts";
import { createBrief as makeBrief } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
import type {
  SortAnswer,
  SortInput,
  SortScope,
} from "../documents/sorting.ts";
import { dismissItems as dismissDrafts } from "../record/items.ts";
import { saveChanges as saveToRecord } from "../record/save.ts";
import type { Store } from "../store/database.ts";

export const TOOLS: readonly Tool[] = [
  getOverview,
  getRecords,
  getDocuments,
  readChat,
  saveChanges,
  dismissItems,
  sortDocuments,
  retryReading,
  createBrief,
];

/**
 * The name the agent knows Rufi's MCP server by: on a code-mode model the AI
 * calls `tools.mcp__rufi__get_overview`. tools.json names them rufi.<tool>.
 */
const SERVER = "rufi";

/** Why a Rufi event's turn can't save or make a brief. */
const EVENT_TURN =
  "This turn was started by a Rufi event, not by the user, so nothing can be saved or made in it. Explain or ask; the user asks in a message of their own.";

/** Why a Rufi event's turn can't start a reading. */
const EVENT_TURN_RETRY =
  "This turn was started by a Rufi event, not by the user, so no reading can start in it. Ask the user; they can ask you to read it again in a message of their own.";

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
 * Rufi event started can only read: the person didn't ask for it. The one
 * exception is a sort's own turn, which can sort its add (and nothing
 * else): Rufi asked for it.
 */
export function chatCaller(
  reader: Store | undefined,
  transcripts: Transcripts,
  log: Log,
  pages?: Pages,
  retry?: (personId: string, documentId: string) => Promise<number[]>,
  sort?: (scope: SortScope, input: SortInput) => Promise<SortAnswer>,
) {
  return (chat: ChatRow, agentTurnId: string, origin: "person" | "rufi") =>
    forAgent(
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
        // A Rufi-started turn may sort only for its own request: sorting.ts
        // checks that, in the sort's transaction.
        sort: (input, callId) =>
          sort
            ? sort(
                {
                  personId: chat.personId,
                  chatId: chat.id,
                  agentTurnId,
                  callId,
                },
                input,
              )
            : Promise.reject(new Refusal("Rufi can't sort documents here.")),
        retryReading: (documentId) =>
          origin === "rufi"
            ? Promise.reject(new Refusal(EVENT_TURN_RETRY))
            : retry
              ? retry(chat.personId, documentId)
              : Promise.reject(new Refusal("Rufi can't read documents here.")),
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
}
