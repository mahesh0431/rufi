// How many restarts in a row Rufi carries on a turn that ran when it
// stopped (docs/adr/0024): the person's setting, 5 until they choose.

/** The setting that keeps it. */
export const CONTINUES_SETTING = "continues_after_restart";

const DEFAULT_CONTINUES = 5;

/** The person's setting, as Settings keeps it; 5 until they choose. */
export async function continuesAfterRestart(
  setting: (key: string) => Promise<string | undefined>,
): Promise<number> {
  const kept = await setting(CONTINUES_SETTING);
  return kept === undefined ? DEFAULT_CONTINUES : Number(kept);
}
