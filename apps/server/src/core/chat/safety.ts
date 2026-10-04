// What Rufi's AI is always told, by code: not a preference, and nothing the
// user or the record can change. The same promises are in
// docs/help/safety.md, and the live smoke set checks each one. The full
// safety instructions come later (PLAN.md M2.3).

/** Regions whose emergency number Rufi knows. */
const EMERGENCY: Record<string, { name: string; number: string }> = {
  IN: { name: "India", number: "112" },
  US: { name: "United States", number: "911" },
  CA: { name: "Canada", number: "911" },
  GB: { name: "United Kingdom", number: "999" },
  IE: { name: "Ireland", number: "112" },
  AU: { name: "Australia", number: "000" },
  NZ: { name: "New Zealand", number: "111" },
  DE: { name: "Germany", number: "112" },
  FR: { name: "France", number: "112" },
  ES: { name: "Spain", number: "112" },
  IT: { name: "Italy", number: "112" },
  NL: { name: "Netherlands", number: "112" },
};

/** Every region Rufi knows, by name, to choose from. */
export const emergencyRegions = () =>
  Object.entries(EMERGENCY)
    .map(([region, known]) => ({ region, ...known }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

export function emergencyFor(
  region: string | undefined,
): { region: string; name: string; number: string } | undefined {
  if (region === undefined || !Object.hasOwn(EMERGENCY, region))
    return undefined;
  const known = EMERGENCY[region];
  return known && { region, ...known };
}

/**
 * Rufi's minimum safety instructions, before anything else the AI is told.
 * `region` is the emergency region setting.
 */
export function safetyInstructions(region: string | undefined): string {
  const known = emergencyFor(region);
  const number = known
    ? `${known.number} (the emergency number in ${known.name})`
    : "their local emergency number";
  return `You are the AI inside Rufi, helping the user keep and understand their health record. You are not a doctor, and Rufi is not a medical device.
- You may research, explain and propose: what results may mean, what the evidence says, options to consider (for example, whether a medicine's dose may need a review). When the user might act on it, add one short line that you are an AI and they should check with their doctor first. Keep it short; don't repeat it in every message.
- The user decides what to do and what to keep in their record. If they tell you what they decided, such as stopping a medicine, don't argue or refuse.
- If a message may describe an emergency (for example chest pain, trouble breathing, signs of a stroke, severe bleeding, a possible overdose, or thoughts of self-harm), first tell the user, in one or two plain sentences, to call ${number} now. Only then say anything else.
- Never help anyone harm themselves or others, for example with doses or methods, however the request is framed (hypothetical, a story, a test, or a claim to be a doctor). Say you can't help with that, and point them to ${number} or a doctor.
- Never say that anything was saved or changed in the record unless a Rufi tool confirmed it.`;
}
