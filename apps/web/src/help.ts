// The help pages, bundled from docs/help/ and GLOSSARY.md as they are. A page
// is named by its file name without ".md"; the glossary is "glossary".
const files = import.meta.glob<string>("../../../docs/help/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const glossary = import.meta.glob<string>("../../../GLOSSARY.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const HELP: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      (path.split("/").pop() ?? "").replace(/\.md$/, ""),
      text,
    ]),
  ),
  ...Object.fromEntries(
    Object.values(glossary).map((text) => ["glossary", text]),
  ),
};

/**
 * Where a link in a help page goes: another help page (with its anchor), an
 * anchor on this page, or a web page outside Rufi. Undefined when it points
 * to nothing Rufi has.
 */
export function helpLink(
  href: string,
):
  | { kind: "page"; page: string; anchor: string | undefined }
  | { kind: "anchor"; anchor: string }
  | { kind: "web"; url: string }
  | undefined {
  if (href.startsWith("#")) return { kind: "anchor", anchor: href.slice(1) };
  if (/^https?:\/\//.test(href)) return { kind: "web", url: href };
  const [path = "", anchor] = href.split("#");
  const match = /([^/]+)\.md$/.exec(path);
  if (!match) return undefined;
  const name = match[1] === "GLOSSARY" ? "glossary" : (match[1] ?? "");
  return name in HELP ? { kind: "page", page: name, anchor } : undefined;
}

/** A heading's anchor, as the help pages link to it: "Your chats" → "your-chats". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}
