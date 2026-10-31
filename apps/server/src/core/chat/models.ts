// Which of the providers' models Rufi's AI may run on: the person's
// shortlist in Settings, matched against the models offered now.

/** Rufi's models until the person chooses, the strongest today; the first is a new chat's. */
export const DEFAULT_SHORTLIST = ["gpt-6-astra", "gpt-6.1-sol"];

/** The setting that keeps the shortlist: its model ids, in order, as JSON. */
export const SHORTLIST_SETTING = "models";

/** Why a model can't be chosen, for the person and for agents alike. */
export const NOT_SHORTLISTED = "That model isn't allowed or isn't offered now.";

/** The person's shortlist, as Settings keeps it; Rufi's own until they choose. */
export async function shortlist(
  setting: (key: string) => Promise<string | undefined>,
): Promise<string[]> {
  const kept = await setting(SHORTLIST_SETTING);
  return kept === undefined
    ? DEFAULT_SHORTLIST
    : (JSON.parse(kept) as string[]);
}

/** The offered models that are shortlisted, in the shortlist's order. */
export function allowedModels<M extends { id: string }>(
  offered: readonly M[],
  shortlisted: readonly string[],
): M[] {
  return shortlisted.flatMap((id) =>
    offered.filter((model) => model.id === id),
  );
}
