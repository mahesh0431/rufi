// Settings › Advanced: what Rufi AI is told, in its parts as they are put
// together, each as plain text the user can edit and put back. An edit is
// kept with Rufi's settings and used from the next reply on; a part not
// edited is Rufi's own and follows Rufi's updates (docs/help/chat.md).
import type {
  InstructionPart,
  InstructionPartId,
} from "@rufi/contracts/instructions";
import { useMutation } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { editInstruction, useInstructions } from "./reads.ts";
import { useSavedText } from "./settings-link.tsx";
import { Button, Problem, Section } from "./ui.tsx";

/** Each part's name, and what the user should know about it. */
const PARTS: Record<InstructionPartId, { title: string; about: string }> = {
  safety: {
    title: "Safety and emergencies",
    about:
      "What Rufi AI does when a message may describe an emergency. Rufi's own gives the number of your emergency region (Settings › Profile).",
  },
  core: {
    title: "Rufi's core instructions",
    about:
      "How Rufi AI reads and changes your health record, asks before it saves, and uses its tools and skills.",
  },
  visual: {
    title: "Visual instructions",
    about:
      "When and how Rufi AI draws a chart, a comparison or a process as a visual in a reply.",
  },
  style: {
    title: "Reply style in use",
    about:
      "After everything else: the line for the style chosen in Settings › Chat. Each style keeps its own edit.",
  },
  wordsIntro: {
    title: "Before your own words",
    about:
      "How Rufi AI is told what your own words are. Sent only when you have written some.",
  },
  words: {
    title: "Your own words",
    about:
      "The same as in Settings › Chat. They come last, after the line above.",
  },
};

export function AdvancedOptions() {
  const instructions = useInstructions();
  return (
    <>
      <p>
        What Rufi AI is told with every reply, in its parts. Edits here change
        how Rufi AI answers, handles your health record and responds to an
        emergency. <b>Reset to default</b> puts Rufi's own back. An edit is used
        from your next reply on; a part you haven't edited follows Rufi's
        updates.
      </p>
      {instructions.data === undefined
        ? instructions.error && (
            <Problem
              error={instructions.error}
              retry={() => void instructions.refetch()}
            />
          )
        : instructions.data.map((part) => (
            <PartEditor key={part.id} part={part} />
          ))}
    </>
  );
}

/** One part: its text to edit, saved when you leave it or close Settings, and Reset. */
function PartEditor({ part }: { part: InstructionPart }) {
  const save = useMutation({
    mutationFn: (edit: string | null) => editInstruction(part.id, edit),
  });
  const text = useSavedText(part.text, save.mutateAsync);
  const { title, about } = PARTS[part.id];
  return (
    <Section title={title}>
      <div className="flex items-center gap-2">
        {part.edited && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent-ink">
            Edited
          </span>
        )}
        <p className="flex-1 text-muted">{about}</p>
        {part.edited && (
          <Button
            icon={RotateCcw}
            busy={save.isPending && save.variables === null && "Resetting…"}
            onClick={() => {
              // Rufi's own comes back in place of what you typed.
              save.mutateAsync(null).then(text.drop, () => undefined);
            }}
          >
            Reset to default
          </Button>
        )}
      </div>
      <textarea
        aria-label={title}
        value={text.text}
        spellCheck={false}
        rows={part.id === "core" ? 16 : 6}
        onChange={(event) => {
          text.type(event.target.value);
        }}
        onBlur={text.leave}
        className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-xs"
      />
      {save.error && (
        <p role="alert" className="text-muted">
          {save.error.message}
        </p>
      )}
    </Section>
  );
}
