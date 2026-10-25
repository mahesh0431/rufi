// One item of a batch in Rufi's terms (docs/adr/0023). Whatever an item
// holds, it converts or is skipped with a fixed reason: what is inside a
// batch never fails it, since trying again can't change it. Values are
// stored as they came: a huge or negative number is the source's, and
// Rufi doesn't judge it.
import { typeOf } from "./types.ts";

export type SkipReason =
  | "not_an_object"
  | "missing_field"
  | "wrong_field"
  | "unknown_type"
  | "unit_not_accepted"
  | "not_a_number"
  | "bad_time"
  | "time_without_offset"
  | "end_before_start"
  | "series_missing"
  | "series_bad";

/** An item Rufi couldn't read: its ID when it had one, never its contents. */
export interface Skip {
  id: string | null;
  reason: SkipReason;
  field?: string;
}

/** A device value in Rufi's terms, before it meets the table. */
export interface ConvertedValue {
  externalId: string;
  type: string;
  value: number;
  startAt: string;
  endAt: string;
  utcOffset: number | null;
  timeZone: string | null;
  device: string | null;
  context: string | null;
  series: string | null;
}

export type ValueResult = { value: ConvertedValue } | { skip: Skip };
export type DeletionResult = { id: string } | { skip: Skip };

/** An ID is the source's own, as long as Apple's UUIDs with room to spare. */
const MAX_ID = 200;
/** The furthest a clock is from UTC, in minutes (±18:00). */
const MAX_OFFSET = 18 * 60;

class Skipped {
  constructor(readonly reason: SkipReason, readonly field?: string) {}
}

const skip = (reason: SkipReason, field?: string): never => {
  throw new Skipped(reason, field);
};

type Fields = Record<string, unknown>;

const isObject = (input: unknown): input is Fields =>
  typeof input === "object" && input !== null && !Array.isArray(input);

/** Absent and null both mean "not sent" for the optional fields. */
const sent = (fields: Fields, name: string): boolean =>
  fields[name] !== undefined && fields[name] !== null;

function readId(fields: Fields): string {
  const id = fields.id;
  if (id === undefined || id === null || id === "") skip("missing_field", "id");
  if (typeof id !== "string" || id.length > MAX_ID) skip("wrong_field", "id");
  return id as string;
}

function optionalText(fields: Fields, name: string): string | null {
  if (!sent(fields, name)) return null;
  const text = fields[name];
  if (typeof text !== "string") skip("wrong_field", name);
  return text as string;
}

const WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))$/;
const WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)?$/;

const daysIn = (year: number, month: number): number =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/** An instant with its offset, as UTC with milliseconds; anything else skips. */
function readInstant(input: unknown): string {
  if (typeof input !== "string") return skip("bad_time");
  const match = WITH_OFFSET.exec(input);
  if (match === null) return skip(WITHOUT_OFFSET.test(input) ? "time_without_offset" : "bad_time");
  const [, y, mo, d, h, mi, s = "0", fraction = "", , sign, oh = "0", om = "0"] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [
    number, number, number, number, number, number,
  ];
  const [offsetHours, offsetMinutes] = [Number(oh), Number(om)];
  if (
    month < 1 || month > 12 || day < 1 || day > daysIn(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetMinutes > 59 || offsetHours * 60 + offsetMinutes > MAX_OFFSET
  ) {
    return skip("bad_time");
  }
  const offset = (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute - offset, second, Number(fraction.padEnd(3, "0").slice(0, 3)));
  return at.toISOString();
}

function readSpan(fields: Fields, onBad: (reason: SkipReason, field?: string) => never) {
  for (const name of ["start", "end"]) if (!sent(fields, name)) onBad("missing_field", name);
  const startAt = readInstant(fields.start);
  const endAt = readInstant(fields.end);
  if (endAt < startAt) onBad("end_before_start");
  return { startAt, endAt };
}

function readNumber(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) skip("not_a_number");
  return input as number;
}

/** A condensed value's own values: each with its interval, or the item skips. */
function readSeries(fields: Fields, factor: number): string | null {
  const hasCount = sent(fields, "count");
  const count = fields.count;
  if (hasCount && (typeof count !== "number" || !Number.isInteger(count) || count < 1)) {
    skip("wrong_field", "count");
  }
  const series = fields.series;
  const empty = !sent(fields, "series") || (Array.isArray(series) && series.length === 0);
  if (empty) {
    if (hasCount && (count as number) > 1) skip("series_missing");
    return null;
  }
  if (!Array.isArray(series) || (hasCount && series.length !== count)) skip("series_bad");
  const parts = (series as unknown[]).map((part) => {
    try {
      if (!isObject(part)) return skip("series_bad");
      const { startAt, endAt } = readSpan(part, () => skip("series_bad"));
      return { start_at: startAt, end_at: endAt, value: readNumber(part.value) * factor };
    } catch (error) {
      if (error instanceof Skipped) return skip("series_bad");
      throw error;
    }
  });
  return JSON.stringify(parts);
}

/** The type's context keys from the item's metadata, as the source gave them. */
function readContext(fields: Fields, keep: readonly string[]): string | null {
  if (!sent(fields, "metadata")) return null;
  const metadata = fields.metadata;
  if (!isObject(metadata)) return skip("wrong_field", "metadata");
  const kept = Object.fromEntries(keep.filter((key) => key in metadata).map((key) => [key, metadata[key]]));
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept);
}

function readValue(system: string, fields: Fields, id: string): ConvertedValue {
  if (!sent(fields, "type")) skip("missing_field", "type");
  const type = typeof fields.type === "string" ? typeOf(system, fields.type) : undefined;
  if (type === undefined) return skip("unknown_type");
  if (fields.value === undefined) skip("missing_field", "value");
  const number = readNumber(fields.value);
  if (!sent(fields, "unit")) skip("missing_field", "unit");
  const factor = typeof fields.unit === "string" ? type.accepts[fields.unit] : undefined;
  if (factor === undefined) return skip("unit_not_accepted");
  const { startAt, endAt } = readSpan(fields, skip);
  let utcOffset: number | null = null;
  if (sent(fields, "utc_offset")) {
    const offset = fields.utc_offset;
    if (typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET) {
      skip("wrong_field", "utc_offset");
    }
    utcOffset = offset as number;
  }
  return {
    externalId: id,
    type: type.key,
    value: number * factor,
    startAt,
    endAt,
    utcOffset,
    timeZone: optionalText(fields, "time_zone"),
    device: optionalText(fields, "device"),
    context: readContext(fields, type.context),
    series: readSeries(fields, factor),
  };
}

function caught(error: unknown, id: string | null): { skip: Skip } {
  if (!(error instanceof Skipped)) throw error;
  return { skip: error.field === undefined ? { id, reason: error.reason } : { id, reason: error.reason, field: error.field } };
}

/** One entry of a batch's `values`, from the given source system. */
export function convertValue(system: string, input: unknown): ValueResult {
  if (!isObject(input)) return { skip: { id: null, reason: "not_an_object" } };
  let id: string;
  try {
    id = readId(input);
  } catch (error) {
    return caught(error, null);
  }
  try {
    return { value: readValue(system, input, id) };
  } catch (error) {
    return caught(error, id);
  }
}

/** One entry of a batch's `deleted`: the ID it takes back. */
export function convertDeletion(input: unknown): DeletionResult {
  if (!isObject(input)) return { skip: { id: null, reason: "not_an_object" } };
  try {
    return { id: readId(input) };
  } catch (error) {
    return caught(error, null);
  }
}
