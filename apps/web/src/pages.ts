// Where the core gives a person's document and its pages, and which page a
// step of Activity read.

export const documentPath = (personId: string, documentId: string) =>
  `/api/people/${encodeURIComponent(personId)}/documents/${encodeURIComponent(documentId)}`;

/** Where the core gives page `position` of a document. */
export const pagePath = (
  personId: string,
  documentId: string,
  position: number,
) => `${documentPath(personId, documentId)}/pages/${String(position)}`;

/**
 * The page of a document a tool's result showed: the page Rufi's
 * get_documents gave as an image, by the call's own arguments, in Codex's
 * report (`arguments`, `result.content`) or Claude's (`use.input`,
 * `result.content`). None for any other step.
 */
export function pageOf(
  item: Record<string, unknown>,
): { document: string; page: number } | undefined {
  const use = item["use"] as { input?: unknown } | undefined;
  const args = (item["arguments"] ?? use?.input) as
    | { document?: unknown; page?: unknown }
    | null
    | undefined;
  const content = (item["result"] as { content?: unknown } | null | undefined)
    ?.content;
  const image =
    Array.isArray(content) &&
    content.some((part) => (part as { type?: unknown }).type === "image");
  if (!image || typeof args?.document !== "string") return undefined;
  if (typeof args.page !== "number") return undefined;
  return { document: args.document, page: args.page };
}
