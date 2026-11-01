// Rufi's own instructions for a reply in OpenUI Lang: its preamble, its
// rules and its example. OpenUI's generated guide (openui.md, from the
// screens' reply library) marks where each goes; here the text (Rufi's own,
// or the user's edit in Settings › Advanced) is put there.
import { REPLY_MARKS } from "@rufi/contracts/instructions";

/** The top of Rufi's reply instructions: how a reply is shown. */
const PREAMBLE = `# How your answer is shown

Rufi's chat draws your answer with OpenUI. Write your whole final answer in openui-lang, the declarative UI language below, and nothing else: no Markdown around it and no code fence. Rufi draws it as it is written. Notes you write while you work, before your answer, are a sentence or two of plain text.`;

/** Rufi's own rules for a reply, one per line, after OpenUI's. */
const RULES = [
  "Every value, date and range you show comes from the user's health record, a document in this chat or a source you cite, as it is kept there. Never invent, round off or fill in a value, not even as an example. A value a chart can't take as a number, such as \"<5\", stays as printed in the text or a table.",
  "A chart of health values is a picture of them, and its labels and hover round numbers: show the values it draws as kept too, in a Table or the text, with their units and as printed.",
  "Links go in TextContent as Markdown links, [words](address): a web page by its https address, and a page of Rufi by its rufi:/ address as your instructions say. A Card's sources and @OpenUrl take the same addresses.",
  "A picture you made is a file in your folder: show it with Image(alt, path).",
  "Buttons and follow-ups send their words to you as the user's message, and a form sends its values. Offer only what you can do for the user in Rufi.",
  "Build a reply from OpenUI's parts, as its examples do: a section under an InlineHeader, with a Separator between sections; a list of points as a ListBlock, each ListItem a short title with its detail as the subtitle; a sequence as Steps. Markdown in TextContent is for running text.",
  "Colours carry meaning: never colour a health value good or bad by your own judgement; for a result, show the lab's own flag as printed.",
];

/** Rufi's own example reply, after OpenUI's examples. */
const EXAMPLE = `Example — One test over time, from the user's record (fictional values):

root = Card([header, intro, chart, values, followUps])
header = CardHeader("Haemoglobin", "Your last three results")
intro = TextContent("Your haemoglobin went up this year and reached the lab's range (12.0-15.5 g/dL) in August. The values are from [your Sunrise Labs report](rufi:/documents/doc-1).")
chart = LineChart(["10 Feb 2026", "20 May 2026", "12 Aug 2026"], [Series("Haemoglobin (g/dL)", [11.2, 11.9, 12.6])])
values = Table([Col("Date", ["10 Feb 2026", "20 May 2026", "12 Aug 2026"]), Col("Haemoglobin", ["11.2 g/dL", "11.9 g/dL", "12.6 g/dL"]), Col("Lab range", ["12.0-15.5", "12.0-15.5", "12.0-15.5"]), Col("Flag", ["L", "L", ""])])
followUps = Buttons([Button("What can raise my haemoglobin?", @ToAssistant("What can raise my haemoglobin?"), "secondary"), Button("Show my ferritin too", @ToAssistant("Show my ferritin too"), "secondary")], "row")`;

/** Rufi's reply instructions as the user sees and edits them. */
export const REPLY_PARTS = {
  replyPreamble: PREAMBLE,
  replyRules: RULES.map((rule) => `- ${rule}`).join("\n"),
  replyExample: EXAMPLE,
} as const;

/** OpenUI's guide with Rufi's reply instructions where it marks them. */
export function withReplyParts(
  guide: string,
  parts: Record<keyof typeof REPLY_PARTS, string>,
): string {
  return guide
    .split(REPLY_MARKS.preamble)
    .join(parts.replyPreamble)
    .split(`- ${REPLY_MARKS.rules}`)
    .join(parts.replyRules)
    .split(REPLY_MARKS.example)
    .join(parts.replyExample);
}
