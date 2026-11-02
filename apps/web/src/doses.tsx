// A medicine's Doses (docs/help/record.md): its dose log of the last 14
// days, as the rows came (docs/adr/0033), by day, newest first, in plain
// words. Nothing is worked out from the times: a dose with no log has no
// row, and nothing is counted, coloured or called missed.
import type { DoseLogRow, MedicineUseRow } from "@rufi/contracts/record";
import { dayLine } from "./dates.ts";
import { useDoses, useToday } from "./reads.ts";
import { clockTime, loggedWhere } from "./today.tsx";
import { Problem } from "./ui.tsx";

/** The days the part shows, today among them. */
const DAYS = 14;
/** A log that came this much after it was made says when it arrived. */
const LATE_MS = 5 * 60_000;

/** A local day as 'YYYY-MM-DD'. */
const isoDay = (at: Date) =>
  `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** "21:00 taken at 21:15 (told Rufi AI)", "08:00 taken 08:12 (iPhone, arrived 19:02)". */
function words(row: DoseLogRow): string {
  const what =
    row.state === "taken"
      ? row.takenAt === undefined
        ? `taken ${clockTime(row.loggedAt)}`
        : `taken at ${clockTime(row.takenAt)}`
      : row.state === "skipped"
        ? "skipped"
        : "undone";
  const where = row.by === "rufi_ai" ? "told Rufi AI" : loggedWhere(row.by);
  const late =
    Date.parse(row.receivedAt) - Date.parse(row.loggedAt) >= LATE_MS
      ? `, arrived ${clockTime(row.receivedAt)}`
      : "";
  return `${row.doseAt.slice(11)} ${what} (${where}${late})`;
}

export function MedicineDoses({
  personId,
  medicine,
}: {
  personId: string;
  medicine: MedicineUseRow;
}) {
  // The Mac's day, as Today has it: it moves on at midnight and when the
  // window comes back, and the days shown with it.
  const day = useToday(personId).data?.day;
  const [y = 0, m = 1, d = 1] = (day ?? "").split("-").map(Number);
  const now = new Date(y, m - 1, d);
  const first = new Date(y, m - 1, d - (DAYS - 1));
  const read = useDoses(
    personId,
    medicine.id,
    isoDay(first),
    isoDay(now),
    day !== undefined,
  );
  const rows = read.data?.doses;
  // Only a medicine with times has doses to log; one logged before keeps them.
  if (medicine.times === undefined && (rows?.length ?? 0) === 0) return null;
  const days = new Map<string, DoseLogRow[]>();
  for (const row of (rows ?? []).toReversed()) {
    const day = row.doseAt.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  return (
    <section aria-labelledby={`doses-${medicine.id}`} className="pt-3">
      <h3 id={`doses-${medicine.id}`} className="font-semibold">
        Doses <span className="font-normal text-muted">· last {DAYS} days</span>
      </h3>
      {read.error ? (
        <Problem error={read.error} retry={() => void read.refetch()} />
      ) : rows === undefined ? null : rows.length === 0 ? (
        <p className="text-muted">No doses logged in the last {DAYS} days.</p>
      ) : (
        <ul>
          {[...days].map(([day, logged]) => {
            const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
            return (
              <li key={day} className="grid grid-cols-[96px_1fr] gap-x-3">
                <span className="text-muted">
                  {dayLine(new Date(y, m - 1, d).toISOString(), now)}
                </span>
                <span>{logged.toReversed().map(words).join(" · ")}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
