// The theme (src/themes.css), set before the page paints so it never flashes
// the wrong one: the system's appearance, followed when it changes. A plain
// script in <head>, so it runs before the first paint.
{
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset["theme"] = dark.matches ? "dark" : "light";
  };
  apply();
  dark.addEventListener("change", apply);
}
