// What Rufi AI is told, in its parts, as Settings › Advanced shows and edits
// them.
import { Schema } from "effect";

/** The parts of Rufi AI's instructions, in the order they are put together. */
export const InstructionPartId = Schema.Literals([
  "safety",
  "core",
  "visual",
  "style",
  "wordsIntro",
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

/** The longest edit Rufi keeps. */
export const MAX_INSTRUCTION_CHARS = 200_000;

/** An edit to one part; null puts Rufi's own back. */
export const EditInstruction = Schema.Struct({
  part: InstructionPartId,
  text: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(MAX_INSTRUCTION_CHARS)),
  ),
});
