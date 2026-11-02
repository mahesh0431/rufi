// The theme (its values: packages/brand/tokens.css), set before the page
// paints so it never flashes the wrong one. The core serves the page with the chosen appearance on
// <html data-appearance>: light or dark stay so; system follows the system's
// appearance, also when it changes. When it is chosen again, the screens
// change data-appearance and the theme follows at once (src/appearance.tsx).
// OpenUI's replies take the same theme, by their own attribute
// (data-openui-theme). A plain script in <head>, so it runs before the first
// paint.
{
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    // In Rufi's iPhone app, always the iPhone's own (src/phone.ts).
    const chosen =
      root.dataset["place"] === "phone" ? "system" : root.dataset["appearance"];
    const theme =
      chosen === "light" || chosen === "dark"
        ? chosen
        : dark.matches
          ? "dark"
          : "light";
    root.dataset["theme"] = theme;
    root.dataset["openuiTheme"] = theme;
  };
  apply();
  dark.addEventListener("change", apply);
  new MutationObserver(apply).observe(root, {
    attributeFilter: ["data-appearance"],
  });
}
