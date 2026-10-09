// How Rufi looks: System (the Mac's light or dark appearance), Light or
// Dark. The core keeps the choice and serves every page with it, so the page
// paints in it first time (public/theme.js); here it is chosen, and every
// open page shows a new choice at once.
import { Appearance as Choice } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { queries, saveSettings, useSettings } from "./reads.ts";

const CHOICES: { value: Choice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Shows the chosen appearance on this page, as it changes. */
export function useAppearance(): void {
  const chosen = useSettings().data?.appearance;
  useEffect(() => {
    if (chosen !== undefined) {
      document.documentElement.dataset["appearance"] = chosen;
    }
  }, [chosen]);
}

/**
 * System, Light or Dark, saved as it is chosen. Named by `labelledBy`, a
 * heading the page already has, or else by its own label.
 */
export function AppearanceChoice({ labelledBy }: { labelledBy?: string }) {
  const label = useId();
  const settings = useSettings();
  // What was just chosen, shown until the core has it.
  const [picked, setPicked] = useState<Choice>();
  const choose = useMutation({
    // One save at a time, so the last choice is the one kept.
    scope: { id: "appearance" },
    mutationFn: (appearance: Choice) => saveSettings({ appearance }),
    onError: () => void queries.invalidateQueries({ queryKey: ["settings"] }),
    onSettled: () => {
      setPicked(undefined);
    },
  });
  const chosen = picked ?? settings.data?.appearance;
  if (chosen === undefined) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        {labelledBy === undefined && <span id={label}>Appearance</span>}
        <div
          role="radiogroup"
          aria-labelledby={labelledBy ?? label}
          className="inline-flex rounded-lg border border-line bg-side p-0.5"
        >
          {CHOICES.map((choice) => (
            <label
              key={choice.value}
              className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name="appearance"
                value={choice.value}
                checked={chosen === choice.value}
                onChange={() => {
                  setPicked(choice.value);
                  // The page takes it at once; the core's answer follows.
                  queries.setQueryData(
                    ["settings"],
                    (old: typeof settings.data) =>
                      old && { ...old, appearance: choice.value },
                  );
                  choose.mutate(choice.value);
                }}
                // Over the whole segment, unseen: the segment is the radio.
                className="absolute inset-0 m-0 cursor-pointer opacity-0"
              />
              {choice.label}
            </label>
          ))}
        </div>
      </div>
      {choose.error && (
        <p role="alert" className="text-muted">
          {choose.error.message}
        </p>
      )}
    </div>
  );
}
