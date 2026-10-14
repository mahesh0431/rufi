// A setting of a few choices, as one segmented control: saved as it is
// chosen, and shown at once on every open page.
import type { Settings } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { queries, saveSettings, useSettings } from "./reads.ts";

type Chosen = "appearance" | "activity";

/**
 * The choices of a setting, the chosen one checked. Named by `labelledBy`,
 * a heading the page already has, or else by its own `label`.
 */
export function SettingChoice<K extends Chosen>({
  setting,
  choices,
  label,
  labelledBy,
}: {
  setting: K;
  choices: readonly { value: Settings[K]; label: string }[];
  label: string;
  labelledBy?: string | undefined;
}) {
  const own = useId();
  const settings = useSettings();
  // What was just chosen, shown until the core has it.
  const [picked, setPicked] = useState<Settings[K]>();
  const choose = useMutation({
    // One save at a time, so the last choice is the one kept.
    scope: { id: setting },
    mutationFn: (value: Settings[K]) => saveSettings({ [setting]: value }),
    onError: () => void queries.invalidateQueries({ queryKey: ["settings"] }),
    onSettled: () => {
      setPicked(undefined);
    },
  });
  const chosen = picked ?? settings.data?.[setting];
  if (chosen === undefined) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        {labelledBy === undefined && <span id={own}>{label}</span>}
        <div
          role="radiogroup"
          aria-labelledby={labelledBy ?? own}
          className="inline-flex rounded-lg border border-line bg-side p-0.5"
        >
          {choices.map((choice) => (
            <label
              key={choice.value}
              className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name={setting}
                value={choice.value}
                checked={chosen === choice.value}
                onChange={() => {
                  setPicked(choice.value);
                  // The page takes it at once; the core's answer follows.
                  queries.setQueryData(
                    ["settings"],
                    (old: Settings | undefined) =>
                      old && { ...old, [setting]: choice.value },
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
