// Today on the Medicines page (docs/help/record.md): what to take at each
// time today, from each current medicine's times. A time already past is
// muted: it means only "earlier today", never taken or skipped. With no
// dose today but one to come, it says so; with none to come, it isn't shown.
// Reminders are a status here: they change in the chat, with Ask Rufi.
import type { MedicineUseRow, Today } from "@rufi/contracts/record";
import { Bell, BellOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { AskRufi } from "./ask.tsx";
import { printedDate, today as longDay } from "./dates.ts";
import { useToday } from "./reads.ts";
import { ICON } from "./ui.tsx";

/** "until 6 Nov, 08:00": a course's last dose, without its year this year. */
export function untilWords(until: MedicineUseRow["until"]): string | undefined {
  if (until === undefined) return undefined;
  const [date = "", time] = until.date.split("T");
  const printed = printedDate(date).replace(
    ` ${String(new Date().getFullYear())}`,
    "",
  );
  return `until ${printed}${time === undefined ? "" : `, ${time}`}`;
}

/** A medicine's reminders, as a status. */
export function Reminders({ on }: { on: boolean }) {
  const Icon = on ? Bell : BellOff;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted">
      <Icon size={ICON} aria-hidden />
      {on ? "Reminders on" : "Reminders off"}
    </span>
  );
}

const dayOf = (day: Today["day"]) => {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return longDay(new Date(y, m - 1, d));
};

export function MedicinesToday({
  personId,
  onAsk,
}: {
  personId: string;
  onAsk: (medicine: MedicineUseRow) => void;
}) {
  const read = useToday(personId);
  const today = read.data;
  // A reminder's click opens the page at Today: once it is there, into view.
  const section = useRef<HTMLElement | null>(null);
  const shown = today !== undefined;
  useEffect(() => {
    if (shown && window.location.hash === "#today") {
      section.current?.scrollIntoView({ block: "start" });
    }
  }, [shown]);
  if (today === undefined) return null;
  if (today.doses.length === 0 && !today.upcoming) return null;
  return (
    <section
      id="today"
      ref={section}
      aria-labelledby="today-heading"
      className="mb-4 scroll-mt-4 rounded-xl border border-line bg-surface"
    >
      <h2
        id="today-heading"
        className="border-b border-line px-3 py-2 font-semibold"
      >
        Today{" "}
        <span className="font-normal text-muted">· {dayOf(today.day)}</span>
      </h2>
      {today.doses.length === 0 ? (
        <p className="px-3 py-2 text-muted">Nothing to take today.</p>
      ) : (
        <ul>
          {today.doses.map(({ at, past, medicine }) => (
            <li
              key={`${at}:${medicine.id}`}
              className={`grid grid-cols-[48px_1.2fr_2fr_auto_auto] items-center gap-2 border-t border-line px-3 py-2 first:border-t-0 ${past ? "text-muted" : ""}`}
            >
              <span className="font-semibold tabular-nums">
                {at}
                {past && <span className="sr-only">, earlier today</span>}
              </span>
              <span className="min-w-0 font-semibold">
                {[medicine.name, medicine.strength].filter(Boolean).join(" ")}
              </span>
              <span className="min-w-0 text-muted">
                {[
                  medicine.amount,
                  medicine.directions,
                  untilWords(medicine.until),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Reminders on={medicine.remind} />
              <AskRufi
                onClick={() => {
                  onAsk(medicine);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
