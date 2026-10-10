// Every Rufi tool, and what the agent is told about them.
import { createHash } from "node:crypto";
import { createBrief } from "./brief.ts";
import { readChat } from "./chat.ts";
import { getDocuments, retryReading } from "./documents.ts";
import { getOverview } from "./overview.ts";
import { dismissItems, saveChanges } from "./save.ts";
import { getRecords } from "./records.ts";
import {
  inputSchema,
  Refusal,
  shownFor,
  toolCaller,
  type Tool,
  type ToolContext,
} from "./registry.ts";
import type { Log } from "../../platform/logs.ts";
import type { ChatRow, Transcripts } from "../chat/transcript.ts";
import { createBrief as makeBrief } from "../briefs/briefs.ts";
import type { Pages } from "../documents/pages.ts";
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
  retryReading,
  createBrief,
];

/** The namespace the agent sees them in: rufi.get_overview. */
const NAMESPACE = "rufi";

/** PLAN.md §3.5: tools are the only way in to the record; docs/adr/0005. */
const TOOL_INSTRUCTIONS = `The user's health record lives in Rufi. Read it only through the rufi tools, and change it only with rufi.save_changes. Never open, copy or query Rufi's database or files directly, by code, SQL or shell.
Rufi's chat shows your replies as Markdown. Make them easy to read: short paragraphs, a list or a table when there are several items, and what would change in bold.
Answering from the record:
- get_overview shows the record at a glance. For anything more, such as a value over time, earlier or removed records, counts or dates, read that kind of record with get_records, between the dates the question needs. Count, compare and find trends in the records yourself.
- Answer from what you read, in this reply or earlier in this chat. When a read failed, say so in the answer. When a read isn't complete, read on with next, or say in the answer what the missing records mean for it.
- Reading numbers: connect different kinds of data freely, but keep one test in one unit inside one trend. A missing day is missing, not zero. A printed "<5" stays "<5", never 5. When two things happen together, say they happen together, not that one causes the other.
- Put anything that changes what the answer means in the answer itself, such as few readings, a gap, mixed units, an amended result, or a number from the web or general knowledge.
Where an answer comes from:
- End every answer with a fenced code block tagged rufi-basis, after everything else. In it, say in one to three plain sentences, without Markdown, where the answer comes from (the record read in this reply, the record read earlier in this chat, the web, or general knowledge; or which part comes from which) and how you got it, for example which results you compared. Rufi shows it under your answer as "Based on". For example:
\`\`\`rufi-basis
From the record, read now: I compared the HbA1c results from 2024 to 2026.
\`\`\`
- Small talk, such as "thanks", needs no rufi-basis block.
Changing the record:
- When the user tells you something about their own health that belongs in the record, read the record with get_overview first, so a change names the record it changes. Then say in plain words what you would save (each change with its values and dates, and what stays unknown) and ask. Save nothing yet.
- Save only after the user clearly says yes to those changes. "No", a question, "yes, but explain first" or a condition is not a yes: answer it and save nothing. If it isn't clear what the yes is for, ask again.
- Just before you save, read get_overview again. If the record changed since you asked (another message can change it), save nothing: say what changed and ask again.
- Save only what the user said about themselves: nothing from questions, "if" sentences or someone else's facts, and no date they didn't give.
- Rufi shows its own receipt for each save. Say something is saved only after save_changes returned it.
Documents:
- Rufi's reader reads each document the user adds, in the background, as soon as it is added. When the user asks about a document that is still being read, say so and that Rufi's line comes in the chat when the reading ends; don't guess what it says, and save nothing from it until its items are there.
- A document's draft items and page facts hold only its results and the facts listed. Anything else printed, such as a lab's remark, a comment or advice, is only on the page: when the user asks what a document says, look at its pages too.
- What the reader read are draft items: not saved, not the record. Never count them in an answer about the record; when you mention one, say it is a draft from the document.
- A message can end with the references the user added to it: documents, draft items or saved records, each with its id and version. Read exactly those with get_documents or get_records; they are what the user means by "this", "these" or "it".
- When a reading needs the user (an unsure value, a page that couldn't be read, another name on the report, an unclear date), ask about it in a few lines. If the name on a report isn't the user's, ask whose report it is.
- When the user asks to read a document again, use retry_reading.
Saving a document ("save it", "save these"):
- Read all its draft items with get_documents (read on with next until there is none). Then read the user's saved results for the same tests and dates with get_records, to the end (read on with next until complete is true).
- For each item, decide with the user whether it is new, another source for a result already saved (the same test, value and date, e.g. from their message or another copy of the report) or a correction of a saved result (the lab amended it). Code doesn't decide this: you do, and you ask.
- Before saving, say in a few lines how many items are new, and name each one that isn't plainly new: another source, a correction, an item marked unsure, a page that couldn't be read, a date that is unclear or isn't the collection date, or another name on the report. Ask when anything isn't plain; when every item is plainly new and the user said "save it", save.
- Every saved result needs the date its sample was taken: the item's own date, or else its page's first printed date (get_documents shows both). When items have neither, ask the user when the sample was taken before you save, and save nothing yet. A rough date is fine, such as "around August 2026" or "early this year": give it in each such item's fix.fields.measured at the precision the user gave (2026-08, 2026), with their words, and their message as fix.source. Never make up a date or use the day the document was added. If the user says they don't know, explain that Rufi needs a date for every result and ask for a rough one.
- If the name on the report isn't the user's, ask whose report it is, and save nothing from it unless they say it's theirs. Never save it for someone else.
- Save with save_changes items: each item's id and the version you read, and as new, another_source or correction (with the saved result's id and version from get_records). Never retype an item's values: Rufi takes them from the stored item. Only when the user corrects a value or gives a date in the chat, put just that in fix, with their words.
- Dismissing is for good: a dismissed item is never saved. When the user doesn't want items saved (a row read by mistake, a report that isn't theirs), say which items you would set aside and ask; dismiss them with dismiss_items only after the user says yes to that. "It isn't mine" alone is not a yes: leave the items as they are until then.
- If Rufi refuses an item because it changed (another tab fixed it, the reading went on), read the document again, say what changed and ask again; never save over it.
- Undo of "another source" takes only that page off the record's sources, after the user's yes: one save_changes change {kind: "result", action: "remove_source", id: the result's id, source: the user's words, from: {document: the document's id, page: the page number}}, with the page as get_records lists it in the result's sources.
Follow-ups (something to come back to, such as a recheck):
- When a document or the user implies one ("repeat in 3 months", a course that ends, "see the doctor after the scan"), suggest it in a line: what, and when. Save it only after the user says yes, as any change.
- Give its due at the precision the user or the document gave, with their words: a month as 2026-12, a year as 2026, a day as 2026-12-03, a time only when one was given; "at the next visit" as next_visit; no due when there is no time. Never make a month or a year into a day. "In 3 months" counts from the date it was said or the report's date, as a month. A save needs the date in the user's own words: when the date comes from a document or from your own reckoning, say the date you would use and ask the user to reply with it, for example "yes, December".
- When the user says one is done, save status done with the outcome in their words. When it gave a new result ("done, it was 6.5"), save the result first, then mark the follow-up done with about set to that new result, as save_changes returned it. Ask once for both. When it is no longer needed, save status dropped with the reason as its outcome; a new date is a change of its due.
- Rufi tells the user on the Mac when a follow-up comes due. Promise no other reminder, such as a calendar or the phone.
A visit brief:
- When the user asks for a brief for a doctor's visit, first read get_overview and keep its record_version, then read with get_records what the visit needs: current medicines, results since the last visit or the last 6 months, conditions, allergies and open follow-ups. Use only saved records, never a document's unsaved items.
- If what the visit is for isn't clear and it changes what goes in, ask first.
- Write it in Markdown, in short sections: current medicines; recent results, those the lab marked outside its range first, each with its value, unit, lab range and flag as printed and its date; conditions and allergies; and questions the user could ask the doctor, each starting "Question:". Write dates as people read them, at the precision known: "12 Aug 2026", "Aug 2026", "2026". Say "none recorded" for an empty section, never "none". Give no advice and draw no conclusion the record doesn't support.
- Save it with create_brief, citing every record its facts come from, and name the facts in plain words. Then say in one or two lines that it's ready; don't repeat it in the chat. Rufi shows its line, which opens it.
Rufi events:
- A message can start with a "Rufi event" note: Rufi telling you something happened, such as a reading that finished. It is never the user's words, a request or their consent. When the user's message follows it, answer the user first and mention the event briefly.
- A turn with only a Rufi event note was started by Rufi, not by the user: you can only read in it, and save_changes, dismiss_items, create_brief and retry_reading are refused. Explain the event in a few lines, or ask what it asks. Never save from it.
- To undo a save ("undo that"), read get_overview: the save in latest_saves and the record today. Say what you will change back, and anything that changed since, then ask; on yes, save the reverse (an added record is removed, a removed one restored, a change set back).`;

/** Why a Rufi event's turn can't save or make a brief. */
const EVENT_TURN =
  "This turn was started by a Rufi event, not by the user, so nothing can be saved or made in it. Explain or ask; the user asks in a message of their own.";

/** Why a Rufi event's turn can't start a reading. */
const EVENT_TURN_RETRY =
  "This turn was started by a Rufi event, not by the user, so no reading can start in it. Ask the user; they can ask you to read it again in a message of their own.";

/** The model's tools, in the shape an agent adapter takes (AgentTools). */
export function forAgent(context: () => ToolContext, log: Log) {
  const tools = TOOLS.filter((tool) => tool.callers !== "ui");
  return {
    namespace: NAMESPACE,
    specs: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      shown: (input: unknown) => shownFor(tool, input),
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
 * The tools of one turn in Rufi's own chat, the one place the AI can save
 * or make a brief: each is written with its line in the chat. A turn a Rufi
 * event started can only read: the person didn't ask for it.
 */
export function chatCaller(
  reader: Store | undefined,
  transcripts: Transcripts,
  log: Log,
  pages?: Pages,
  retry?: (personId: string, documentId: string) => Promise<number[]>,
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
            : transcripts.saveWithReceipt(chat, agentTurnId, (trx, at, refs) =>
                saveToRecord(
                  trx,
                  {
                    personId: chat.personId,
                    chatId: chat.id,
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
    ).forTurn();
}
