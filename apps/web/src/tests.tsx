// Lab results by test, and a test's own page (docs/adr/0028). Lab results
// lists each of the person's tests that has a lab result, by section, with
// its latest value as printed. A test's page has every current value,
// newest first, each opening in place to its sources and history, then
// the test's own history. The pages only show: changes start in the chat,
// with Ask Rufi.
import type { Person } from "@rufi/contracts";
import type { LabTest, ResultRow, TestValue } from "@rufi/contracts/record";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AskRufi, AskRufiEmpty } from "./ask.tsx";
import { askRufi } from "./panel.ts";
import { useLabResults, useTestPage } from "./reads.ts";
import {
  cellsOf,
  chipOf,
  dated,
  join,
  RowDetail,
  rowElementId,
} from "./record.tsx";
import { Trend } from "./trend.tsx";
import { EmptyState, Problem } from "./ui.tsx";

/** The heading of the tests with no section. */
const NO_SECTION = "Other tests";

const values = (n: number) => `${String(n)} ${n === 1 ? "value" : "values"}`;

export function LabResultsPage({ person }: { person: Person }) {
  const lab = useLabResults(person.id);
  if (lab.data === undefined) {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8">
        {lab.error && (
          <Problem error={lab.error} retry={() => void lab.refetch()} />
        )}
      </div>
    );
  }
  const { sections, trends } = lab.data;
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <p className="mb-3 text-muted">
        Each test once, with its latest value as printed. Changes start in the
        chat: <b className="font-semibold">Ask Rufi</b> on a row.
      </p>
      {sections.length === 0 ? (
        <EmptyState action={<AskRufiEmpty personId={person.id} />}>
          Nothing here yet.
        </EmptyState>
      ) : (
        sections.map(({ section, tests }) => {
          const name = section ?? NO_SECTION;
          return (
            <section
              key={section ?? ""}
              aria-label={name}
              className="mb-3 rounded-xl border border-line bg-surface"
            >
              <h2 className="border-b border-line px-3 py-2 font-semibold">
                {name}
              </h2>
              <ul>
                {tests.map((test) => (
                  <TestLine
                    key={test.test.id}
                    personId={person.id}
                    test={test}
                    trend={trends[test.latest.id]}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

/** A test on Lab results: its name opens its page; its latest value as printed. */
function TestLine({
  personId,
  test,
  trend,
}: {
  personId: string;
  test: LabTest;
  /** Its latest value's small trend. */
  trend: readonly ResultRow[] | undefined;
}) {
  const { test: row, latest } = test;
  if (
    "problem" in row ||
    row.kind !== "test" ||
    "problem" in latest ||
    latest.kind !== "result"
  ) {
    return (
      <li className="border-t border-line px-3 py-2 text-muted italic first:border-t-0">
        Can't show this row.
      </li>
    );
  }
  const cells = cellsOf(latest);
  return (
    <li className="border-t border-line first:border-t-0">
      <div className="group grid grid-cols-[1.1fr_0.9fr_96px_0.8fr_0.8fr_0.7fr_auto] items-center gap-2 px-3 py-2 hover:bg-side">
        <span className="min-w-0">
          <Link
            to="/people/$personId/tests/$testId"
            params={{ personId, testId: row.id }}
            className="font-semibold"
          >
            {row.name}
          </Link>
          <span className="block text-xs text-muted">{values(test.count)}</span>
        </span>
        <span>
          {cells.value}
          {cells.note !== undefined && (
            <span className="text-muted"> {cells.note}</span>
          )}
        </span>
        <span>{trend && <Trend mini title={row.name} values={trend} />}</span>
        <span className="text-muted">{cells.detail}</span>
        <span>{cells.status}</span>
        <span className="text-muted">{cells.date}</span>
        <span className="text-right">
          <AskRufi
            onClick={() => {
              askRufi(personId, [chipOf(row)]);
            }}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * A test's page; `opened`: the id of a value to open and bring into view
 * (a lab result's links come here).
 */
export function TestPage({
  person,
  testId,
  opened,
}: {
  person: Person;
  testId: string;
  opened?: string;
}) {
  const page = useTestPage(person.id, testId);
  const [open, setOpen] = useState<string | null>(opened ?? null);
  const loaded = page.data !== undefined;
  useEffect(() => {
    if (!loaded || opened === undefined) return;
    document
      .getElementById(rowElementId("result", opened))
      ?.scrollIntoView({ block: "center" });
  }, [loaded, opened]);
  if (page.data === undefined) {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8">
        {page.error && (
          <Problem error={page.error} retry={() => void page.refetch()} />
        )}
      </div>
    );
  }
  const { test } = page.data;
  if ("problem" in test || test.kind !== "test") {
    return (
      <div className="mx-auto max-w-[790px] px-6 py-8 text-muted italic">
        Can't show this test.
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[790px] px-6 py-8">
      <div className="mb-3.5">
        <h2 className="flex items-start gap-3 text-[22px] font-bold">
          <span className="min-w-0 flex-1">{test.name}</span>
          <AskRufi
            onClick={() => {
              askRufi(person.id, [chipOf(test)]);
            }}
          />
        </h2>
        <p className="text-muted">
          {[test.section ?? NO_SECTION, test.unit].filter(Boolean).join(" · ")}
        </p>
      </div>
      <section aria-labelledby="values">
        <h3 id="values" className="mb-1 font-semibold">
          {values(page.data.values.length)}
        </h3>
        {page.data.values.length === 0 ? (
          <EmptyState>No values in your health record now.</EmptyState>
        ) : (
          <ul className="rounded-xl border border-line bg-surface">
            {page.data.values.map((value) => (
              <ValueLine
                key={value.row.id}
                personId={person.id}
                value={value}
                unit={test.unit}
                open={open === value.row.id}
                onOpen={() => {
                  setOpen(open === value.row.id ? null : value.row.id);
                }}
              />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="this-test" className="mt-6">
        <h3 id="this-test" className="mb-1 font-semibold">
          This test
        </h3>
        <div className="rounded-xl border border-line bg-surface">
          <RowDetail personId={person.id} row={test} />
        </div>
      </section>
    </div>
  );
}

/**
 * Its numbers in the test's unit, when either differs from the printed
 * ones, with its stored comparator: "1.1 mg/dL" beside "97 µmol/L", "<0.5
 * mg/dL" beside "<45 µmol/L".
 */
function inTestUnit(row: ResultRow, unit: string | undefined) {
  if (row.test_number === undefined) return undefined;
  if (
    row.test_number === row.number &&
    row.test_second_number === row.second_number
  ) {
    return undefined;
  }
  const numbers =
    row.test_second_number === undefined
      ? String(row.test_number)
      : `${String(row.test_number)}/${String(row.test_second_number)}`;
  return join(`${row.comparator ?? ""}${numbers}`, unit);
}

/** A value on a test's page: its date opens it to its sources and history. */
function ValueLine({
  personId,
  value,
  unit,
  open,
  onOpen,
}: {
  personId: string;
  value: TestValue;
  /** The test's unit. */
  unit: string | undefined;
  open: boolean;
  onOpen: () => void;
}) {
  const { row, report } = value;
  if ("problem" in row || row.kind !== "result") {
    return (
      <li className="border-t border-line px-3 py-2 text-muted italic first:border-t-0">
        Can't show this row.
      </li>
    );
  }
  const cells = cellsOf(row);
  const converted = inTestUnit(row, unit);
  return (
    <li
      id={rowElementId("result", row.id)}
      className="border-t border-line first:border-t-0"
    >
      <div
        className={`grid grid-cols-[0.8fr_0.9fr_1fr_1fr_0.8fr_0.9fr] items-center gap-2 px-3 py-2 ${open ? "bg-accent-soft" : "hover:bg-side"}`}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onOpen}
          className="min-w-0 text-left font-semibold"
        >
          {dated(row.measured) ?? "No date"}
        </button>
        <span>
          {cells.value}
          {converted !== undefined && (
            <span className="block text-xs text-muted">= {converted}</span>
          )}
        </span>
        <span>
          {row.test}
          {cells.note !== undefined && (
            <span className="text-muted"> {cells.note}</span>
          )}
        </span>
        <span className="text-muted">
          {report === null
            ? "Typed in the chat"
            : (report.issuer ?? "A report")}
        </span>
        <span className="text-muted">{cells.detail}</span>
        <span>{cells.status}</span>
      </div>
      {open && <RowDetail personId={personId} row={row} overTime={false} />}
    </li>
  );
}
