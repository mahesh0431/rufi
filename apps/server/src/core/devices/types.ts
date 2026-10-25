// Rufi's type list: what a device value measures, as master data in code
// (docs/adr/0023). A value row stores only its type's key. A key that has
// shipped is never removed or renamed, and its meaning and storage unit
// never change: a new meaning or unit is a new key, or a migration of the
// stored values. The label may change. Adding a type is an entry here, a
// fixture and a test; the phone then sends that type's history.

export interface DeviceType {
  /** Fixed forever: stored on every value of this type. */
  key: string;
  /** What people read; it may change. */
  label: string;
  /** The unit every value of this type is stored in, as a UCUM code. */
  unit: string;
  /** The LOINC code for what it measures. */
  loinc: string;
  /** Apple Health's identifier for it. */
  apple: string;
  /** The units a source may send it in, each with its factor to `unit`. */
  accepts: Readonly<Record<string, number>>;
  /** The metadata keys kept with a value, as the source sent them. */
  context: readonly string[];
}

// Apple writes beats per minute as count/min; UCUM writes it /min.
const PER_MINUTE = { "count/min": 1, "/min": 1 } as const;

export const DEVICE_TYPES: readonly DeviceType[] = [
  {
    key: "resting_heart_rate",
    label: "Resting heart rate",
    unit: "/min",
    loinc: "40443-4",
    apple: "HKQuantityTypeIdentifierRestingHeartRate",
    accepts: PER_MINUTE,
    context: [],
  },
];

/** The type a source system names an item with, if Rufi knows it. */
export function typeOf(system: string, name: string): DeviceType | undefined {
  if (system !== "apple_health") return undefined;
  return DEVICE_TYPES.find((type) => type.apple === name);
}
