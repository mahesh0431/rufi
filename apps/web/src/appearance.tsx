// How Rufi looks: System (the Mac's light or dark appearance), Light or
// Dark; its colour theme; and how Rufi AI's reply sits in the chat. The core
// keeps the choices and serves every page with them, so the page paints in
// them first time (public/theme.js, packages/brand/tokens.css); here they
// are chosen, and every open page shows a new choice at once.
import type { Colour } from "@rufi/contracts";
import { useEffect } from "react";
import { SettingChoice, useChoice } from "./choice.tsx";
import { useSettings } from "./reads.ts";

/** Shows the chosen appearance, colour and reply shape on this page, as they change. */
export function useAppearance(): void {
  const settings = useSettings().data;
  const chosen = settings?.appearance;
  const colour = settings?.colour;
  const shape = settings?.replyShape;
  useEffect(() => {
    const root = document.documentElement.dataset;
    if (chosen !== undefined) root["appearance"] = chosen;
    if (colour !== undefined) root["colour"] = colour;
    if (shape !== undefined) root["replyShape"] = shape;
  }, [chosen, colour, shape]);
}

/**
 * System, Light or Dark, saved as it is chosen. Named by `labelledBy`, a
 * heading the page already has, or else by its own label.
 */
export function AppearanceChoice({ labelledBy }: { labelledBy?: string }) {
  return (
    <SettingChoice
      setting="appearance"
      label="Appearance"
      labelledBy={labelledBy}
      choices={[
        { value: "system", label: "System" },
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
      ]}
    />
  );
}

const COLOURS: readonly { value: Colour; label: string }[] = [
  { value: "white", label: "White" },
  { value: "blue", label: "Blue" },
  { value: "periwinkle", label: "Periwinkle" },
  { value: "plum", label: "Plum" },
  { value: "ocean", label: "Ocean" },
  { value: "graphite", label: "Graphite" },
  { value: "sand", label: "Sand" },
];

/**
 * The colour themes as swatches, each drawn in its own theme's colours (its
 * `data-colour`), in the light or dark the page shows. Saved as one is
 * picked; the whole app changes at once.
 */
export function ColourChoice({ labelledBy }: { labelledBy: string }) {
  const { chosen, pick, error } = useChoice("colour");
  if (chosen === undefined) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        className="grid grid-cols-4 gap-2"
      >
        {COLOURS.map((colour) => (
          <label
            key={colour.value}
            data-colour={colour.value}
            className="relative flex cursor-pointer flex-col gap-1.5 rounded-[10px] border border-line bg-page p-2 has-checked:outline-2 has-checked:outline-offset-1 has-checked:outline-accent has-focus-visible:outline-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name="colour"
              value={colour.value}
              checked={chosen === colour.value}
              onChange={() => {
                pick(colour.value);
              }}
              // Over the whole swatch, unseen: the swatch is the radio.
              className="absolute inset-0 m-0 cursor-pointer opacity-0"
            />
            <span aria-hidden className="flex items-center gap-1.5">
              <span className="h-3.5 w-7 rounded-full bg-accent" />
              <span className="h-3.5 w-10 rounded-full bg-accent-soft" />
            </span>
            <span className="font-medium text-ink">{colour.label}</span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-muted">
          {error.message}
        </p>
      )}
    </div>
  );
}
