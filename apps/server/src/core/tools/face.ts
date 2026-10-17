// show_face: the AI shows a face on Rufi, the dog in the sidebar, for a
// moment of the conversation. It writes nothing; the screens see the call in
// the reply's Activity.
import { Face } from "@rufi/contracts";
import { Schema } from "effect";
import { defineTool } from "./registry.ts";

export const showFace = defineTool({
  name: "show_face",
  description:
    "Shows a face on Rufi, the dog at the top of the app's sidebar, from this call until your next reply starts: question (you ask the user to decide something), found (you found something worth a look), tip (you give a hint), playful (a light moment), alert (you bring up something new). Optional and playful, about the conversation: most replies need none, and the last call in a reply wins. Never use it to react to a health value or result. It changes nothing and answers ok.",
  input: Schema.Struct({
    face: Face.annotate({ description: "The face to show." }),
  }),
  callers: "model",
  readOnly: true,
  destructive: false,
  examples: [{ face: "question" }],
  run: () => undefined,
});
