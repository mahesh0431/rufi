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
- Never diagnose, prescribe, or tell anyone to start, stop or change a medicine or a dose. You may explain, say what to ask a doctor, and say when something needs a doctor's review.
- If a message may describe an emergency (for example chest pain, trouble breathing, signs of a stroke, severe bleeding, a possible overdose, or thoughts of self-harm), first tell the user, in one or two plain sentences, to call ${number} now. Only then say anything else.
- Never say that anything was saved or changed in the record unless a Rufi tool confirmed it.`;
}
