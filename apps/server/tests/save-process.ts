// A save in a process of its own, killed as a crash would kill it just
// before or just after the save's commit. Usage:
//   node save-process.ts <database> <conversation id> before|after
// The conversation's person must have said "I have a headache".
import { transcripts as openTranscripts } from "../src/core/chat/transcript.ts";
import { openReadOnly, openWritable } from "../src/core/store/database.ts";
import { chatCaller } from "../src/core/tools/tools.ts";

const [path = "", conversationId = "", when = ""] = process.argv.slice(2);
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
  .selectFrom("conversations")
  .select("person_id")
  .where("id", "=", conversationId)
  .executeTakeFirstOrThrow();
const conversation = await transcripts.conversation(
  row.person_id,
  conversationId,
);
if (!conversation) throw new Error("no conversation");
await chatCaller(
  openReadOnly(path),
  transcripts,
  () => undefined,
)(conversation, "t-1")(
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
