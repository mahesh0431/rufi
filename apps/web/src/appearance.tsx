// How Rufi looks: System (the Mac's light or dark appearance), Light or
// Dark. The core keeps the choice and serves every page with it, so the page
// paints in it first time (public/theme.js); here it is chosen, and every
// open page shows a new choice at once.
import { useEffect } from "react";
import { SettingChoice } from "./choice.tsx";
import { useSettings } from "./reads.ts";

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
