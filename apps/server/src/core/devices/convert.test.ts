import { describe, expect, it } from "vitest";
import { convertDeletion, convertValue } from "./convert.ts";

const RESTING = "HKQuantityTypeIdentifierRestingHeartRate";

/** A good Apple resting heart rate item; each case changes one thing. */
const item = (changes: Record<string, unknown> = {}) => ({
  id: "9A01-91C0",
  type: RESTING,
  value: 54,
  unit: "count/min",
  start: "2026-10-20T00:00:00+05:30",
  end: "2026-10-20T23:59:59+05:30",
  ...changes,
});

/** What the good item becomes, with the same changes in Rufi's terms. */
const stored = (changes: Record<string, unknown> = {}) => ({
  externalId: "9A01-91C0",
  type: "resting_heart_rate",
  value: 54,
  startAt: "2026-10-19T18:30:00.000Z",
  endAt: "2026-10-20T18:29:59.000Z",
  utcOffset: null,
  timeZone: null,
  device: null,
  context: null,
  series: null,
  ...changes,
});

const without = (field: string) => {
  const copy: Record<string, unknown> = item();
  delete copy[field];
  return copy;
};

const series = [
  { start: "2026-10-20T06:10:00Z", end: "2026-10-20T06:11:30Z", value: 118 },
  { start: "2026-10-20T06:11:30Z", end: "2026-10-20T06:14:00Z", value: 131 },
  { start: "2026-10-20T06:14:00Z", end: "2026-10-20T06:16:00Z", value: 127 },
];

// Every shape an item can come in: converted, or skipped with its reason.
// A batch fails only for outside causes, never for what an item holds.
const CASES: [string, unknown, unknown][] = [
  ["a good item", item(), { value: stored() }],
  ["UTC times", item({ start: "2026-10-19T18:30:00Z", end: "2026-10-20T18:29:59.000Z" }), { value: stored() }],
  ["a basic offset (+0530) and lower-case t and z", item({ start: "2026-10-20t00:00:00+0530", end: "2026-10-20t18:29:59z" }), { value: stored({ endAt: "2026-10-20T18:29:59.000Z" }) }],
  ["minutes without seconds", item({ start: "2026-10-19T18:30Z", end: "2026-10-19T18:31Z" }), { value: stored({ endAt: "2026-10-19T18:31:00.000Z" }) }],
  ["microseconds, cut to milliseconds", item({ start: "2026-10-19T18:30:00.123456Z", end: "2026-10-19T18:30:00.999999Z" }), { value: stored({ startAt: "2026-10-19T18:30:00.123Z", endAt: "2026-10-19T18:30:00.999Z" }) }],
  ["UCUM's /min", item({ unit: "/min" }), { value: stored() }],
  ["a zero, as sent", item({ value: 0 }), { value: stored({ value: 0 }) }],
  ["a huge number, as sent", item({ value: 1e300 }), { value: stored({ value: 1e300 }) }],
  ["a negative number, as sent", item({ value: -3.5 }), { value: stored({ value: -3.5 }) }],
  ["the place it was taken", item({ utc_offset: 330, time_zone: "Asia/Kolkata" }), { value: stored({ utcOffset: 330, timeZone: "Asia/Kolkata" }) }],
  ["a null offset and zone, as if absent", item({ utc_offset: null, time_zone: null }), { value: stored() }],
  ["the device", item({ device: "Apple Watch" }), { value: stored({ device: "Apple Watch" }) }],
  ["metadata the type doesn't keep", item({ metadata: { HKMetadataKeyWasUserEntered: true } }), { value: stored() }],
  ["fields Rufi doesn't know", item({ colour: "blue" }), { value: stored() }],
  ["a series of unequal values", item({ value: 125, count: 3, series }), { value: stored({ value: 125, series: JSON.stringify([
    { start_at: "2026-10-20T06:10:00.000Z", end_at: "2026-10-20T06:11:30.000Z", value: 118 },
    { start_at: "2026-10-20T06:11:30.000Z", end_at: "2026-10-20T06:14:00.000Z", value: 131 },
    { start_at: "2026-10-20T06:14:00.000Z", end_at: "2026-10-20T06:16:00.000Z", value: 127 },
  ]) }) }],
  ["a series without a count", item({ value: 125, series }), { value: stored({ value: 125, series: expect.any(String) }) }],
  ["count 1 and no series", item({ count: 1 }), { value: stored() }],

  ["not an object: null", null, { skip: { id: null, reason: "not_an_object" } }],
  ["not an object: a list", [item()], { skip: { id: null, reason: "not_an_object" } }],
  ["not an object: text", "54", { skip: { id: null, reason: "not_an_object" } }],
  ["no id", without("id"), { skip: { id: null, reason: "missing_field", field: "id" } }],
  ["an empty id", item({ id: "" }), { skip: { id: null, reason: "missing_field", field: "id" } }],
  ["a number for an id", item({ id: 42 }), { skip: { id: null, reason: "wrong_field", field: "id" } }],
  ["an id too long", item({ id: "x".repeat(201) }), { skip: { id: null, reason: "wrong_field", field: "id" } }],
  ["no type", without("type"), { skip: { id: "9A01-91C0", reason: "missing_field", field: "type" } }],
  ["a type Rufi doesn't know", item({ type: "HKQuantityTypeIdentifierStepCount" }), { skip: { id: "9A01-91C0", reason: "unknown_type" } }],
  ["Rufi's own key instead of Apple's", item({ type: "resting_heart_rate" }), { skip: { id: "9A01-91C0", reason: "unknown_type" } }],
  ["no value", without("value"), { skip: { id: "9A01-91C0", reason: "missing_field", field: "value" } }],
  ["a value as text", item({ value: "54" }), { skip: { id: "9A01-91C0", reason: "not_a_number" } }],
  ["NaN, as text", item({ value: "NaN" }), { skip: { id: "9A01-91C0", reason: "not_a_number" } }],
  ["infinity (1e400 in JSON)", item({ value: Number.POSITIVE_INFINITY }), { skip: { id: "9A01-91C0", reason: "not_a_number" } }],
  ["a null value", item({ value: null }), { skip: { id: "9A01-91C0", reason: "not_a_number" } }],
  ["true as a value", item({ value: true }), { skip: { id: "9A01-91C0", reason: "not_a_number" } }],
  ["no unit", without("unit"), { skip: { id: "9A01-91C0", reason: "missing_field", field: "unit" } }],
  ["a unit Rufi doesn't accept", item({ unit: "count/s" }), { skip: { id: "9A01-91C0", reason: "unit_not_accepted" } }],
  ["bpm, not a unit code", item({ unit: "bpm" }), { skip: { id: "9A01-91C0", reason: "unit_not_accepted" } }],
  ["no start", without("start"), { skip: { id: "9A01-91C0", reason: "missing_field", field: "start" } }],
  ["no end", without("end"), { skip: { id: "9A01-91C0", reason: "missing_field", field: "end" } }],
  ["a time with no offset", item({ start: "2026-10-20T00:00:00" }), { skip: { id: "9A01-91C0", reason: "time_without_offset" } }],
  ["a date alone", item({ end: "2026-10-20" }), { skip: { id: "9A01-91C0", reason: "time_without_offset" } }],
  ["30 February", item({ start: "2026-02-30T00:00:00Z" }), { skip: { id: "9A01-91C0", reason: "bad_time" } }],
  ["hour 24", item({ start: "2026-10-20T24:00:00Z" }), { skip: { id: "9A01-91C0", reason: "bad_time" } }],
  ["an offset of 25 hours", item({ start: "2026-10-20T00:00:00+25:00" }), { skip: { id: "9A01-91C0", reason: "bad_time" } }],
  ["words for a time", item({ start: "yesterday" }), { skip: { id: "9A01-91C0", reason: "bad_time" } }],
  ["a number for a time", item({ start: 1792490400000 }), { skip: { id: "9A01-91C0", reason: "bad_time" } }],
  ["an end before its start", item({ end: "2026-10-19T00:00:00Z" }), { skip: { id: "9A01-91C0", reason: "end_before_start" } }],
  ["an offset in hours, not minutes", item({ utc_offset: 5.5 }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "utc_offset" } }],
  ["an offset past 18 hours", item({ utc_offset: 1200 }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "utc_offset" } }],
  ["an offset as text", item({ utc_offset: "+05:30" }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "utc_offset" } }],
  ["a number for a zone", item({ time_zone: 330 }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "time_zone" } }],
  ["a device as an object", item({ device: { name: "Apple Watch" } }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "device" } }],
  ["metadata as a list", item({ metadata: [] }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "metadata" } }],
  ["a count of 0", item({ count: 0 }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "count" } }],
  ["a count as text", item({ count: "3" }), { skip: { id: "9A01-91C0", reason: "wrong_field", field: "count" } }],
  ["a count of 3 and no series", item({ count: 3 }), { skip: { id: "9A01-91C0", reason: "series_missing" } }],
  ["a count of 3 and an empty series", item({ count: 3, series: [] }), { skip: { id: "9A01-91C0", reason: "series_missing" } }],
  ["a series one value short", item({ count: 3, series: series.slice(0, 2) }), { skip: { id: "9A01-91C0", reason: "series_bad" } }],
  ["a series value with no number", item({ count: 3, series: [series[0], { start: series[1]?.start, end: series[1]?.end }, series[2]] }), { skip: { id: "9A01-91C0", reason: "series_bad" } }],
  ["a series value with a time without offset", item({ count: 3, series: [series[0], { ...series[1], start: "2026-10-20T06:11:30" }, series[2]] }), { skip: { id: "9A01-91C0", reason: "series_bad" } }],
  ["a series that isn't a list", item({ count: 3, series: { values: series } }), { skip: { id: "9A01-91C0", reason: "series_bad" } }],
];

describe("converting an item of a batch", () => {
  it.each(CASES)("%s", (_case, input, expected) => {
    expect(convertValue("apple_health", input)).toEqual(expected);
  });
});

// A deletion names only the ID it takes back.
const DELETIONS: [string, unknown, unknown][] = [
  ["an ID", { id: "2F6B-7F3A" }, { id: "2F6B-7F3A" }],
  ["not an object", "2F6B-7F3A", { skip: { id: null, reason: "not_an_object" } }],
  ["no ID", {}, { skip: { id: null, reason: "missing_field", field: "id" } }],
  ["a number for an ID", { id: 7 }, { skip: { id: null, reason: "wrong_field", field: "id" } }],
];

describe("converting a deletion", () => {
  it.each(DELETIONS)("%s", (_case, input, expected) => {
    expect(convertDeletion(input)).toEqual(expected);
  });
});
