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
import { useState } from "react";
import { editInstruction, useInstructions } from "./reads.ts";
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
  replyPreamble: {
    title: "Reply instructions: preamble",
    about: "The start of OpenUI's guide below: how a reply is shown.",
  },
  replyRules: {
    title: "Reply instructions: rules",
    about: "Rufi's own rules for a reply, after OpenUI's rules in its guide.",
  },
  replyExample: {
    title: "Reply instructions: example",
    about: "Rufi's own example reply, after OpenUI's examples in its guide.",
  },
  openui: {
    title: "OpenUI's guide",
    about:
      "Made by OpenUI from Rufi's reply parts. The three reply instructions above go where it marks them, such as <<Rufi's reply rules>>.",
  },
  style: {
    title: "Reply style in use",
    about:
      "After everything else: the line for the style chosen in Settings › Chat. Each style keeps its own edit.",
  },
  words: {
    title: "Your own words",
    about:
      "The same as in Settings › Chat. Rufi AI is told they are your wishes for replies, and that Rufi's rules come first.",
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
            // A new text from Rufi (a reset, another tab) starts the box again.
            <PartEditor key={`${part.id}:${part.text}`} part={part} />
          ))}
    </>
  );
}

/** One part: its text to edit, saved when you leave it, and Reset. */
function PartEditor({ part }: { part: InstructionPart }) {
  const [text, setText] = useState(part.text);
  const save = useMutation({
    mutationFn: (edit: string | null) => editInstruction(part.id, edit),
  });
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
              save.mutate(null);
            }}
          >
            Reset to default
          </Button>
        )}
      </div>
      <textarea
        aria-label={title}
        value={text}
        spellCheck={false}
        rows={part.id === "openui" || part.id === "core" ? 16 : 6}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onBlur={() => {
          if (text !== part.text) save.mutate(text);
        }}
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
