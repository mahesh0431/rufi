// A save in a process of its own, killed as a crash would kill it just
// before or just after the save's commit. Usage:
//   node save-process.ts <database> <chat id> before|after
// The chat's person must have said "I have a headache".
import { transcripts as openTranscripts } from "../src/core/chat/transcript.ts";
import { openReadOnly, openWritable } from "../src/core/store/database.ts";
import { chatCaller } from "../src/core/tools/tools.ts";

const [path = "", chatId = "", when = ""] = process.argv.slice(2);
const store = openWritable(path);
const crash = () => process.kill(process.pid, "SIGKILL");
// The save's commit is the only one this process makes.
const prepare = store.db.prepare.bind(store.db);
store.db.prepare = (sql: string) => {
  if (sql !== "COMMIT") return prepare(sql);
  if (when === "before") crash();
  const statement = prepare(sql);
  const run = statement.run.bind(statement);
  statement.run = () => {
    const done = run();
    crash();
    return done;
  };
  return statement;
};
const transcripts = openTranscripts(store);
const row = await store.query
  .selectFrom("chats")
  .select("person_id")
  .where("id", "=", chatId)
  .executeTakeFirstOrThrow();
const chat = await transcripts.chat(row.person_id);
if (!chat) throw new Error("no chat");
await chatCaller(openReadOnly(path), transcripts, () => undefined)(chat, "t-1")(
  "save_changes",
  {
    changes: [
      {
        kind: "symptom",
        action: "add",
        source: "I have a headache",
        fields: { name: "Headache" },
      },
    ],
  },
  "call-1",
);
throw new Error("The save ended without its crash.");
