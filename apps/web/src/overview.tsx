// The home: what needs you (each line with Ask Rufi, for the chat box over
// the page), your health record as one tile per page, and the latest saves,
// each opening to its receipt. A tile opens its page. The
// tiles' words are worked out from the saved record, never by the AI.
import type { Person } from "@rufi/contracts";
import type { RecentChange, Tile } from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { AskRufi } from "./ask.tsx";
import { dayLine, greeting, printedDate, printedTime, today } from "./dates.ts";
import { whenDue } from "./follow-ups.tsx";
import { askRufi } from "./panel.ts";
import { KIND_TITLES } from "./record.tsx";
import { useOverview } from "./reads.ts";
import { Receipt } from "./transcript.tsx";
import { buttonLook, ICON, Problem } from "./ui.tsx";

export function OverviewPage({ person }: { person: Person }) {
  const overview = useOverview(person.id);
  // The greeting and date as the page opened.
  const [now] = useState(() => new Date());
  const data = overview.data;
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <p className="text-muted">{today(now)}</p>
      <h1 className="mb-6 text-[22px] font-bold">
        {greeting(now)}, {person.displayName}
      </h1>
      {data === undefined ? (
        overview.error && (
          <Problem
            error={overview.error}
            retry={() => void overview.refetch()}
          />
        )
      ) : (
        <>
          {(data.needsYou.documents.length > 0 ||
            data.needsYou.followUps.length > 0) && (
            <section aria-labelledby="needs-you" className="mb-6">
              <h2 id="needs-you" className="mb-2 px-0.5 font-semibold">
                Needs you
              </h2>
              <ul className="rounded-xl border border-line bg-surface">
                {data.needsYou.documents.map((document) => (
                  <li
                    key={document.id}
                    className="flex items-center gap-2.5 border-t border-line px-3 py-2 first:border-t-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{document.name}</span>{" "}
                      <span className="text-muted">
                        ·{" "}
                        {document.state === "failed"
                          ? "couldn't finish reading"
                          : document.state === "unread_pages"
                            ? "couldn't be read · try a clearer scan"
                            : [
                                `${String(document.results)} ${document.results === 1 ? "result" : "results"} read, not saved`,
                                document.toCheck > 0 &&
                                  `${String(document.toCheck)} to check`,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                      </span>
                    </span>
                    <AskRufi
                      aria-label={`Ask Rufi about ${document.name}`}
                      onClick={() => {
                        askRufi(person.id, [
                          {
                            pointer: { type: "document", id: document.id },
                            label: document.name,
                            detail: "",
                          },
                        ]);
                      }}
                    />
                    <Link
                      to="/people/$personId/documents/$documentId"
                      params={{ personId: person.id, documentId: document.id }}
                      aria-label={`Open ${document.name}`}
                      className={buttonLook({ look: "quiet" })}
                    >
                      <ArrowUpRight size={ICON} aria-hidden />
                      Open
                    </Link>
                  </li>
                ))}
                {data.needsYou.followUps.map(({ state, followUp }) => (
                  <li
                    key={followUp.id}
                    className="flex items-center gap-2.5 border-t border-line px-3 py-2 first:border-t-0"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{followUp.title}</span>{" "}
                      <span className="text-muted">
                        · {state === "coming_up" && "coming up, "}
                        {lower(
                          whenDue(
                            state,
                            followUp.due,
                            new Date(overview.dataUpdatedAt),
                          ).replace(" · ", ", "),
                        )}
                      </span>
                    </span>
                    <AskRufi
                      aria-label={`Ask Rufi about ${followUp.title}`}
                      onClick={() => {
                        askRufi(person.id, [
                          {
                            pointer: {
                              type: "record",
                              kind: "follow_up",
                              id: followUp.id,
                            },
                            label: followUp.title,
                            detail: "",
                          },
                        ]);
                      }}
                    />
                    <Link
                      to="/people/$personId/follow-ups"
                      params={{ personId: person.id }}
                      search={{ open: followUp.id }}
                      aria-label={`Open ${followUp.title}`}
                      className={buttonLook({ look: "quiet" })}
                    >
                      <ArrowUpRight size={ICON} aria-hidden />
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="health-record" className="mb-6">
            <h2 id="health-record" className="mb-2 px-0.5 font-semibold">
              Health record
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
              {data.tiles.map((tile) => (
                <li key={tile.kind}>
                  <TileView personId={person.id} tile={tile} />
                </li>
              ))}
            </ul>
          </section>
          {data.recent.length > 0 && (
            <section aria-labelledby="recent">
              <h2 id="recent" className="mb-2 px-0.5 font-semibold">
                Recent changes
              </h2>
              <ul className="rounded-xl border border-line bg-surface">
                {data.recent.map((change) => (
                  <RecentView key={change.id} change={change} now={now} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Words that follow a dot: "Due this month" → "due this month". */
const lower = (words: string) => words.charAt(0).toLowerCase() + words.slice(1);

const plural = (n: number, one: string, many: string) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** What a tile says under its title, from what the core counted. */
function tileLines(tile: Tile): string[] {
  // "None known" stands beside inactive allergies: only an active one or
  // one of unknown status can't (the save refuses it).
  if (tile.noneKnown !== undefined) {
    return [
      `None known${tile.noneKnown === "" ? "" : ` (as of ${printedDate(tile.noneKnown)})`}`,
      ...(tile.count > 0 ? [`${String(tile.count)} inactive`] : []),
    ];
  }
  if (tile.count === 0) return ["None yet"];
  const names = tile.names.join(", ");
  const latest = tile.latest;
  switch (tile.kind) {
    case "measurement":
      return latest
        ? [
            [`Latest: ${latest.label}`, latest.date && printedDate(latest.date)]
              .filter(Boolean)
              .join(" · "),
          ]
        : [];
    case "lab_result":
      return latest
        ? [
            [
              `Latest: ${latest.label}`,
              latest.date && printedDate(latest.date),
              latest.results !== undefined &&
                plural(latest.results, "result", "results"),
            ]
              .filter(Boolean)
              .join(" · "),
            ...(latest.flagged
              ? [`${String(latest.flagged)} with a lab note`]
              : []),
          ]
        : [];
    case "medicine_use": {
      const now = tile.now ?? 0;
      return [
        `${String(now)} taking now${names === "" ? "" : `: ${names}`}`,
        ...(tile.count > now ? [`${String(tile.count - now)} in history`] : []),
      ];
    }
    case "condition":
      return [
        `${String(tile.now ?? 0)} ongoing${names === "" ? "" : `: ${names}`}`,
      ];
    case "allergy":
      return [
        `${String(tile.now ?? 0)} active${names === "" ? "" : `: ${names}`}`,
      ];
    case "prescription":
    case "symptom":
    case "care_event":
      return latest
        ? [
            [`Latest: ${latest.label}`, latest.date && printedDate(latest.date)]
              .filter(Boolean)
              .join(" · "),
          ]
        : [];
  }
}

function TileView({ personId, tile }: { personId: string; tile: Tile }) {
  const empty = tile.count === 0;
  return (
    <Link
      to="/people/$personId/record/$kind"
      params={{ personId, kind: tile.kind }}
      className="block h-full rounded-xl border border-line bg-surface px-3 py-2.5 hover:bg-side"
    >
      <span
        className={`flex justify-between ${empty ? "text-muted" : "font-semibold"}`}
      >
        {KIND_TITLES[tile.kind]}
        {!empty && <span className="tabular-nums">{tile.count}</span>}
      </span>
      {tileLines(tile).map((line) => (
        <span key={line} className="mt-0.5 block text-[12.5px] text-muted">
          {line}
        </span>
      ))}
    </Link>
  );
}

/** A receipt's first line as plain words: its summary, or its only change. */
function summaryOf(receipt: string): string {
  const lines = receipt
    .split("\n")
    .map((line) =>
      line
        .replace(/^- /, "")
        .replace(/\\(.)|\*/g, (_, kept?: string) => kept ?? ""),
    )
    .filter((line) => line.trim() !== "" && line !== "Saved");
  const [first = "Saved", ...rest] = lines;
  return rest.length === 0
    ? first
    : `${first} · and ${String(rest.length)} more`;
}

/** When a save was: "Today 01:45", "Yesterday 18:02", else "18:31 on 3 Sep 2026". */
function savedAt(iso: string, now: Date): string {
  const day = dayLine(iso, now);
  if (day !== "Today" && day !== "Yesterday") {
    return printedTime(iso).replace(/^at /, "");
  }
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function RecentView({ change, now }: { change: RecentChange; now: Date }) {
  return (
    <li className="border-t border-line px-3 py-2 first:border-t-0">
      <details>
        <summary className="flex cursor-pointer gap-2.5">
          <span className="w-36 shrink-0 text-muted">
            {savedAt(change.at, now)}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {summaryOf(change.receipt)}
          </span>
        </summary>
        <div className="mt-2 rounded-lg border border-line bg-side px-3 py-2">
          <Receipt text={change.receipt} />
        </div>
      </details>
    </li>
  );
}
