// Every Rufi tool, and what the agent is told about them.
import { createHash } from "node:crypto";
import { readConversation } from "./conversation.ts";
import { getOverview } from "./overview.ts";
import { saveChanges } from "./save.ts";
import {
  inputSchema,
  toolCaller,
  type Tool,
  type ToolContext,
} from "./registry.ts";
import type { Log } from "../../platform/logs.ts";
import type { ConversationRow, Transcripts } from "../chat/transcript.ts";
import { saveChanges as saveToRecord } from "../record/save.ts";
import type { Store } from "../store/database.ts";

export const TOOLS: readonly Tool[] = [
  getOverview,
  readConversation,
  saveChanges,
];

/** The namespace the agent sees them in: rufi.get_overview. */
const NAMESPACE = "rufi";

/** PLAN.md §3.5: tools are the only way in to the record; docs/adr/0005. */
const TOOL_INSTRUCTIONS = `The user's health record lives in Rufi. Read it only through the rufi tools, and change it only with rufi.save_changes. Never open, copy or query Rufi's database or files directly, by code, SQL or shell.
Rufi's chat shows your replies as Markdown. Make them easy to read: short paragraphs, a list when there are several items, and what would change in bold.
Changing the record:
- When the user tells you something about their own health that belongs in the record, read the record with get_overview first, so a change names the record it changes. Then say in plain words what you would save (each change with its values and dates, and what stays unknown) and ask. Save nothing yet.
- Save only after the user clearly says yes to those changes. "No", a question, "yes, but explain first" or a condition is not a yes: answer it and save nothing. If it isn't clear what the yes is for, ask again.
- Just before you save, read get_overview again. If the record changed since you asked (another conversation can change it), save nothing: say what changed and ask again.
- Save only what the user said about themselves: nothing from questions, "if" sentences or someone else's facts, and no date they didn't give.
- Rufi shows its own receipt for each save. Say something is saved only after save_changes returned it.
- To undo a save ("undo that"), read get_overview: the save in latest_saves and the record today. Say what you will change back, and anything that changed since, then ask; on yes, save the reverse (an added record is removed, a removed one restored, a change set back).`;

/** The model's tools, in the shape an agent adapter takes (AgentTools). */
export function forAgent(context: () => ToolContext, log: Log) {
  const tools = TOOLS.filter((tool) => tool.callers !== "ui");
  return {
    namespace: NAMESPACE,
    specs: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      shown: tool.shown,
      inputSchema: inputSchema(tool),
    })),
    instructions: TOOL_INSTRUCTIONS,
    forTurn: () => toolCaller(tools, context, log),
  };
}

/**
 * Names the tool set an agent thread started with: a thread keeps its tools,
 * so a different set needs a new thread.
 */
export function toolsVersion(): string {
  const { namespace, specs, instructions } = forAgent(
    () => ({ store: undefined, personId: undefined }),
    () => undefined,
  );
  // What the agent is told; the words a person sees aren't part of it.
  const told = specs.map(({ name, description, inputSchema: input }) => ({
    name,
    description,
    inputSchema: input,
  }));
  return createHash("sha256")
    .update(JSON.stringify({ namespace, specs: told, instructions }))
    .digest("hex")
    .slice(0, 16);
}

/** tools.json: every tool as documentation, generated (pnpm tools:json). */
export function toolsJson(): string {
  const tools = TOOLS.map((tool) => ({
    name: `${NAMESPACE}.${tool.name}`,
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
 * The tools of one turn in Rufi's own chat, the one place the AI can save:
 * a save is written with its receipt in the conversation.
 */
export function chatCaller(
  reader: Store | undefined,
  transcripts: Transcripts,
  log: Log,
) {
  return (conversation: ConversationRow, agentTurnId: string) =>
    forAgent(
      () => ({
        store: reader,
        personId: conversation.personId,
        conversationId: conversation.id,
        save: (changes, callId) =>
          transcripts.saveWithReceipt(conversation, agentTurnId, (trx, at) =>
            saveToRecord(
              trx,
              {
                personId: conversation.personId,
                conversationId: conversation.id,
                callId,
                now: at,
              },
              changes,
            ),
          ),
      }),
      log,
    ).forTurn();
}
