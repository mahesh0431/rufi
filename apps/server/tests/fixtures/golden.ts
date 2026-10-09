// The golden data set: the fictional family, first run done, the emergency
// region set, and a few days of Asha's chat with one saved change. `pnpm
// demo` opens Rufi on it; the screens' tests take the family and first run
// from here too. The chat is written by Rufi's own code (the transcript and
// the tools, as the chat calls them), so it is stored as a real chat is, and
// a change to those rules shows here as a failed seed. Every name and value
// is made up.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { DEFAULT_ALLOWLIST } from "../../src/core/chat/models.ts";
import { transcripts, type ChatRow } from "../../src/core/chat/transcript.ts";
import {
  databasePath,
  openReadOnly,
  type Store,
} from "../../src/core/store/database.ts";
import { originalPath } from "../../src/core/documents/originals.ts";
import { shownDate } from "../../src/core/record/dates.ts";
import { sha256 } from "../../src/platform/files.ts";
import { shownFor } from "../../src/core/tools/registry.ts";
import { chatCaller, TOOLS } from "../../src/core/tools/tools.ts";

export const FAMILY = join(import.meta.dirname, "fictional-family.sql");

/** The family's document files (fictional), which FAMILY's rows name by hash. */
const FAMILY_FILES = [
  "sunrise-labs-august.pdf",
  "thyroid-recheck.jpg",
  "ravi-lipid-panel.pdf",
].map((name) => join(import.meta.dirname, "documents", name));

/** Puts the family's document files in the data folder, as Rufi keeps them. */
export async function familyFiles(home: string): Promise<void> {
  await mkdir(join(home, "files"), { recursive: true, mode: 0o700 });
  for (const file of FAMILY_FILES) {
    await writeFile(
      originalPath(home, await sha256(file)),
      await readFile(file),
      {
        mode: 0o600,
      },
    );
  }
}

/** First run, finished on 1 Oct 2026. */
export const FIRST_RUN_DONE = `INSERT INTO settings (key, value) VALUES
  ('first_run.understood', '2026-10-01T09:00:00Z'),
  ('first_run.sign_in_skipped', '2026-10-01T09:00:00Z'),
  ('first_run.done', '2026-10-01T09:00:00Z');`;

/**
 * Writes the golden data set into a new record, its chat dated in the days
 * before `today` (the Mac's time zone), so its day lines show.
 */
export async function writeGolden(
  home: string,
  store: Store,
  today: Date,
): Promise<void> {
  store.db.exec(await readFile(FAMILY, "utf8"));
  await familyFiles(home);
  store.db.exec(FIRST_RUN_DONE);
  store.db.exec(
    "INSERT INTO settings (key, value) VALUES ('emergency_region', 'IN');",
  );
  await ashasChat(home, store, today);
}

/** A local time `days` before `today`, at `hour`:`minute`. */
function daysBefore(today: Date, days: number, hour: number, minute: number) {
  const at = new Date(today);
  at.setDate(at.getDate() - days);
  at.setHours(hour, minute, 0, 0);
  return at;
}

const localDay = (at: Date) =>
  `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** Asha's chat: a question, a change saved after her yes, a later question. */
async function ashasChat(home: string, store: Store, today: Date) {
  let clock = today;
  const chats = transcripts(store, () => clock.toISOString());
  const chat = (await chats.chat("asha")) as ChatRow;
  const reader = openReadOnly(databasePath(home));
  const tools = chatCaller(reader, chats, () => undefined);
  const thread = { id: "golden-thread", model: DEFAULT_ALLOWLIST[0] ?? "" };

  /** One reply: her message, Rufi's tools as the AI called them, the answer. */
  const turn = async (
    at: Date,
    message: string,
    calls: { tool: string; input: unknown }[],
    reply: string,
  ) => {
    clock = at;
    const agentTurn = uuid();
    await chats.startTurn(chat, agentTurn, thread);
    await chats.addMessage(chat, {
      id: uuid(),
      kind: "message",
      text: message,
      agentTurnId: agentTurn,
    });
    const call = tools(chat, agentTurn);
    for (const { tool, input } of calls) {
      clock = new Date(clock.getTime() + 2_000);
      const callId = uuid();
      const title = shownFor(
        TOOLS.find((t) => t.name === tool) as (typeof TOOLS)[number],
        input,
      );
      await chats.setActivity(chat, agentTurn, callId, {
        activity: "tool",
        title,
        status: "running",
      });
      const startedAt = chats.now();
      const answer = await call(tool, input, callId);
      if (!answer.ok) {
        throw new Error(
          `The golden chat's ${tool} was refused: ${answer.text}`,
        );
      }
      await chats.recordToolCall(chat, agentTurn, {
        callId,
        tool,
        input,
        answer,
        startedAt,
      });
      await chats.setActivity(chat, agentTurn, callId, {
        activity: "tool",
        title,
        status: "done",
      });
    }
    clock = new Date(clock.getTime() + 8_000);
    await chats.appendReply(chat, agentTurn, uuid(), reply);
    await chats.endTurn(chat, agentTurn, { status: "completed" });
  };

  try {
    await turn(
      daysBefore(today, 6, 9, 12),
      "What did my August blood test show?",
      [{ tool: "get_overview", input: {} }],
      `Your August test from Sunrise Labs (collected 12 Aug) has two results marked **High**:

- **HbA1c** 6.8 % (range 4.0 - 5.6)
- **Glucose**, fasting, 118 mg/dL (range 70 - 99)

CRP was <5 mg/L, inside its range. The lab later corrected the TSH from that sample to **4.6 mIU/L**, above its range of 0.4 - 4.0.

The HbA1c and the fasting glucose are worth going over together with your doctor.

\`\`\`rufi-basis
From the record, read now: the results of the Sunrise Labs report collected on 12 Aug 2026, with the corrected TSH.
\`\`\``,
    );

    const said = daysBefore(today, 3, 20, 40);
    const started = daysBefore(today, 5, 0, 0);
    const words = "I started magnesium 200 mg at night two days ago";
    await turn(
      said,
      words,
      [{ tool: "get_overview", input: {} }],
      `Shall I add this to your record?

- **Magnesium** 200 mg, at night, current
- Started **two days ago** (${shownDate(localDay(started))})

Nothing else changes, and what it's for stays unknown.

\`\`\`rufi-basis
From your message in this chat, and the record read now: magnesium isn't in it yet.
\`\`\``,
    );
    await turn(
      new Date(said.getTime() + 90_000),
      "Yes, save it",
      [
        { tool: "get_overview", input: {} },
        {
          tool: "save_changes",
          input: {
            changes: [
              {
                kind: "medicine_use",
                action: "add",
                source: words,
                fields: {
                  name: "Magnesium",
                  strength: "200 mg",
                  schedule: "at night",
                  status: "current",
                  started: { date: localDay(started), words: "two days ago" },
                },
              },
            ],
          },
        },
      ],
      "Magnesium is now with your current medicines.",
    );

    await turn(
      daysBefore(today, 1, 8, 5),
      "Is my TSH something to worry about?",
      [{ tool: "get_records", input: { kind: "result", from: "2026" } }],
      `Your TSH from 12 Aug is **4.6 mIU/L** after the lab's correction, a little above its range (0.4 - 4.0). Your Free T4 from 1 Sep is **1.1 ng/dL**, inside its range.

One raised TSH with a normal Free T4 is something doctors often recheck after a few weeks rather than act on at once. It's worth asking your doctor whether to repeat it.

\`\`\`rufi-basis
From the record, read now: the corrected TSH from 12 Aug 2026 and the Free T4 from 1 Sep 2026. That a single raised TSH is often rechecked is general knowledge.
\`\`\``,
    );
  } finally {
    reader?.close();
  }
}
