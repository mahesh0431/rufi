// Today on the Medicines page (docs/help/record.md): what to take at each
// time today, from each current medicine's times, and what the person
// logged for each dose (docs/adr/0033). A time already past is muted: it
// means only "earlier today". A dose with no log is not logged, never
// missed, and has Taken and Skipped; a logged one says so, with Undo. With
// no dose today but one to come, it says so; with none to come, it isn't
// shown. Reminders are a status here: they change in the chat, with Ask Rufi.
import type {
  DoseState,
  LogDose,
  MedicineUseRow,
  Today,
} from "@rufi/contracts/record";
import {
  Bell,
  BellOff,
  Check,
  RotateCw,
  SkipForward,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { ApiError } from "./api.ts";
import { AskRufi } from "./ask.tsx";
import { printedDate, today as longDay } from "./dates.ts";
import { dosesChanged, logDose, useToday } from "./reads.ts";
import { Button, ICON } from "./ui.tsx";

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

/** Where a dose was logged: "Mac", "iPhone" or "Rufi AI". */
export function loggedWhere(by: string): string {
  if (by === "mac") return "Mac";
  if (by === "rufi_ai") return "Rufi AI";
  // The paired apps are iPhones for now.
  if (by.startsWith("app:")) return "iPhone";
  return by;
}

/** An ISO time as the local "21:02". */
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

type Dose = Today["doses"][number];

/**
 * A dose's log on Today: what was logged, with Undo, or Taken and Skipped.
 * A press makes the log's id; when its answer is lost, the same log goes
 * again on Try again, so the core takes it once.
 */
function DoseLogged({
  personId,
  day,
  dose,
}: {
  personId: string;
  day: Today["day"];
  dose: Dose;
}) {
  const [sending, setSending] = useState<LogDose>();
  const [unsure, setUnsure] = useState<LogDose>();
  const [refused, setRefused] = useState<string>();
  const send = async (log: LogDose) => {
    setSending(log);
    setUnsure(undefined);
    setRefused(undefined);
    try {
      await logDose(personId, log);
      await dosesChanged(personId);
    } catch (error) {
      // No answer, or the core failed: it may have stored it.
      if (
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500
      ) {
        setUnsure(log);
      } else {
        setRefused(error.message);
      }
    } finally {
      setSending(undefined);
    }
  };
  const press = (state: DoseState) => {
    void send({
      id: crypto.randomUUID(),
      medicineUseId: dose.medicine.id,
      doseAt: `${day}T${dose.at}`,
      state,
      loggedAt: new Date().toISOString(),
    });
  };
  const busy = (state: DoseState, label: string) =>
    sending?.state === state && label;
  if (unsure) {
    return (
      <span className="flex items-center gap-2">
        <span role="alert">Not sure it was logged</span>
        <Button look="quiet" icon={RotateCw} onClick={() => void send(unsure)}>
          Try again
        </Button>
      </span>
    );
  }
  const { logged } = dose;
  return (
    <span className="flex items-center justify-end gap-1">
      {refused !== undefined && (
        <span role="alert" className="text-muted">
          {refused}
        </span>
      )}
      {logged ? (
        <>
          <span className="whitespace-nowrap">
            {logged.state === "taken"
              ? `Taken ${clockTime(logged.takenAt ?? logged.loggedAt)}`
              : "Skipped"}{" "}
            · {loggedWhere(logged.by)}
          </span>
          <Button
            look="quiet"
            icon={Undo2}
            busy={busy("cleared", "Undo")}
            disabled={sending !== undefined}
            onClick={() => {
              press("cleared");
            }}
          >
            Undo
          </Button>
        </>
      ) : (
        <>
          <Button
            look="quiet"
            icon={Check}
            busy={busy("taken", "Taken")}
            disabled={sending !== undefined}
            onClick={() => {
              press("taken");
            }}
          >
            Taken
          </Button>
          <Button
            look="quiet"
            icon={SkipForward}
            busy={busy("skipped", "Skipped")}
            disabled={sending !== undefined}
            onClick={() => {
              press("skipped");
            }}
          >
            Skipped
          </Button>
        </>
      )}
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
  if (today === undefined) return null;
  if (today.doses.length === 0 && !today.upcoming) return null;
  return (
    <section
      aria-labelledby="today-heading"
      className="mb-4 rounded-xl border border-line bg-surface"
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
          {today.doses.map((dose) => {
            const { at, past, medicine } = dose;
            return (
              <li
                key={`${at}:${medicine.id}`}
                className={`grid grid-cols-[48px_1.2fr_2fr_224px_auto_auto] items-center gap-2 border-t border-line px-3 py-2 first:border-t-0 ${past ? "text-muted" : ""}`}
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
                <DoseLogged personId={personId} day={today.day} dose={dose} />
                <Reminders on={medicine.remind} />
                <AskRufi
                  onClick={() => {
                    onAsk(medicine);
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
