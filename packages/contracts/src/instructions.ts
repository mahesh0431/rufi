// What Rufi AI is told, in its parts, as Settings › Advanced shows and edits
// them, and the marks in OpenUI's generated guide (openui.md) where Rufi's
// own reply instructions go.
import { Schema } from "effect";

/**
 * Where Rufi's reply instructions go in OpenUI's guide: the screens'
 * library gives OpenUI these marks in place of the text, and the core puts
 * the text (Rufi's own or the user's edit) where they are.
 */
export const REPLY_MARKS = {
  preamble: "<<Rufi's reply preamble>>",
  rules: "<<Rufi's reply rules>>",
  example: "<<Rufi's reply example>>",
} as const;

/** The parts of Rufi AI's instructions, in the order they are put together. */
export const InstructionPartId = Schema.Literals([
  "safety",
  "core",
  "replyPreamble",
  "replyRules",
  "replyExample",
  "openui",
  "style",
  "words",
]);
export type InstructionPartId = typeof InstructionPartId.Type;

/** One part as Rufi AI is told it now: Rufi's own, or the user's edit. */
export const InstructionPart = Schema.Struct({
  id: InstructionPartId,
  text: Schema.String,
  /** The user's edit is in use; false: Rufi's own, which follows updates. */
  edited: Schema.Boolean,
});
export type InstructionPart = typeof InstructionPart.Type;

export const Instructions = Schema.Struct({
  parts: Schema.Array(InstructionPart),
});
export type Instructions = typeof Instructions.Type;

/** The longest edit Rufi keeps: OpenUI's guide is about 50,000 characters. */
export const MAX_INSTRUCTION_CHARS = 200_000;

/** An edit to one part; null puts Rufi's own back. */
export const EditInstruction = Schema.Struct({
  part: InstructionPartId,
  text: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(MAX_INSTRUCTION_CHARS)),
  ),
});
