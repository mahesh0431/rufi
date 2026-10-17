// Which of the provider's models Rufi may use: Rufi's own shortlist, matched
// against the models the account offers now.

/** Rufi's models, the strongest today; the first is the default for a new chat. */
export const DEFAULT_ALLOWLIST = ["gpt-6-astra", "gpt-6.1-sol"];

/** The provider's models that are allowed, in the allowlist's order. */
export function allowedModels<M extends { id: string }>(
  offered: readonly M[],
  allowlist: readonly string[],
): M[] {
  return allowlist.flatMap((id) => offered.filter((model) => model.id === id));
}
