// Your profile: its page (your name in the sidebar opens it), the same form
// in Settings, and its history. The form saves each field once it is
// complete, through the record's one save, with where it was entered as its
// source; a field that fails keeps what you entered, with one line on what
// to do.
import type { Person } from "@rufi/contracts";
import type {
  MadeIn,
  ProfileChange,
  ProfileField,
  ProfileValues,
} from "@rufi/contracts/record";
import { useMutation } from "@tanstack/react-query";
import { Check, Pencil } from "lucide-react";
import {
  type FocusEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { printedDate } from "./dates.ts";
import { savedAt } from "./overview.tsx";
import { saveProfile, useProfile } from "./reads.ts";
import { Button, Problem } from "./ui.tsx";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const BLOOD_GROUPS = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
] as const;

/** A blood group as printed: a minus sign, not a hyphen. */
const bloodGroup = (group: string) => group.replace("-", "−");

/** Each field's name on the screen. */
const FIELD_NAMES: Record<ProfileField, string> = {
  birth_date: "Birth date",
  sex_for_ranges: "Sex for lab ranges",
  blood_group: "Blood group",
  height: "Height",
};

/** A field's value as the page shows it; "Not set" when it has none. */
function shownValue<K extends ProfileField>(
  field: K,
  value: ProfileValues[K],
): string {
  if (value === null) return "Not set";
  switch (field) {
    case "birth_date":
      return printedDate(
        (value as NonNullable<ProfileValues["birth_date"]>).date,
      );
    case "sex_for_ranges":
      return value === "female" ? "Female" : "Male";
    case "blood_group":
      return bloodGroup(value as string);
    case "height": {
      const height = value as NonNullable<ProfileValues["height"]>;
      return `${String(height.value)} ${height.unit}`;
    }
  }
  return "";
}

/** The age today from the birth date: "36", or "about 36" when it is open. */
const ageText = ([youngest, oldest]: readonly [number, number]) =>
  `${youngest === oldest ? "" : "about "}${String(oldest)} years old today`;

/** Where a change was made, as its history says it. */
const MADE_IN: Record<MadeIn, string> = {
  chat: "in the chat",
  welcome: "in the welcome",
  profile: "on this page",
  settings: "in Settings",
};

/** Says what keeps a typed field from being saved, or undefined once nothing does. */
type Report = (field: ProfileField, problem: string | undefined) => void;

/**
 * The profile's fields, each saved by `commit` once it is complete: a
 * choice when it is chosen, a typed field when you leave it after changing
 * it. A typed field shows `values` until you change it, and keeps what you
 * typed until `values` has it.
 */
function ProfileFields({
  values,
  commit,
  report,
}: {
  values: ProfileValues;
  commit: <K extends ProfileField>(field: K, value: ProfileValues[K]) => void;
  report: Report;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      <BirthDate
        id={`${id}-birth`}
        value={values.birth_date}
        commit={(value) => {
          commit("birth_date", value);
        }}
        report={(problem) => {
          report("birth_date", problem);
        }}
      />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium">Sex for lab ranges</legend>
        <div
          role="radiogroup"
          aria-label="Sex for lab ranges"
          className="inline-flex w-fit rounded-lg border border-line bg-side p-0.5"
        >
          {(["female", "male"] as const).map((sex) => (
            <label
              key={sex}
              className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name={`${id}-sex`}
                value={sex}
                checked={values.sex_for_ranges === sex}
                onChange={() => {
                  commit("sex_for_ranges", sex);
                }}
                className="absolute inset-0 m-0 cursor-pointer opacity-0"
              />
              {sex === "female" ? "Female" : "Male"}
            </label>
          ))}
        </div>
        <p className="text-muted">Only for choosing lab ranges.</p>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-blood`} className="font-medium">
          Blood group <span className="font-normal text-muted">optional</span>
        </label>
        <select
          id={`${id}-blood`}
          value={values.blood_group ?? ""}
          onChange={(event) => {
            const chosen = event.target.value;
            commit(
              "blood_group",
              chosen === ""
                ? null
                : (chosen as NonNullable<ProfileValues["blood_group"]>),
            );
          }}
          className="w-32 rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="">Not set</option>
          {BLOOD_GROUPS.map((group) => (
            <option key={group} value={group}>
              {bloodGroup(group)}
            </option>
          ))}
        </select>
      </div>
      <Height
        id={`${id}-height`}
        value={values.height}
        commit={(value) => {
          commit("height", value);
        }}
        report={(problem) => {
          report("height", problem);
        }}
      />
    </div>
  );
}

/** Whether focus left the group, not moved within it. */
const leaves = (event: FocusEvent<HTMLElement>) =>
  !event.currentTarget.contains(event.relatedTarget);

interface TypedDate {
  day: string;
  month: string;
  year: string;
}

/** A saved birth date as its inputs show it. */
function typedDate(value: ProfileValues["birth_date"]): TypedDate {
  const [, year = "", month = "", day = ""] =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(value?.date ?? "") ?? [];
  return {
    day: day === "" ? "" : String(Number(day)),
    month: month === "" ? "" : String(Number(month)),
    year,
  };
}

/** What was typed as a birth date; null when emptied, undefined when incomplete. */
function dateOf(typed: TypedDate): ProfileValues["birth_date"] | undefined {
  if (typed.day === "" && typed.month === "" && typed.year === "") return null;
  if (!/^\d{4}$/.test(typed.year) || (typed.day !== "" && typed.month === "")) {
    return undefined;
  }
  const two = (n: string) => n.padStart(2, "0");
  const date = [
    typed.year,
    typed.month && two(typed.month),
    typed.day && two(typed.day),
  ]
    .filter((part) => part !== "")
    .join("-");
  const words = [
    typed.day,
    typed.month && MONTHS[Number(typed.month) - 1],
    typed.year,
  ]
    .filter((part) => part !== "")
    .join(" ");
  return { date, words };
}

/**
 * A birth date: a year, a month and year, or a full date, with its words
 * as shown ("March 1990"). Saved when focus leaves it changed and complete;
 * emptied, it clears.
 */
function BirthDate({
  id,
  value,
  commit,
  report,
}: {
  id: string;
  value: ProfileValues["birth_date"];
  commit: (value: ProfileValues["birth_date"]) => void;
  report: (problem: string | undefined) => void;
}) {
  // What you typed, until the profile has it; untouched, the field shows the profile.
  const [draft, setDraft] = useState<TypedDate>();
  const [problem, setProblem] = useState<string>();
  if (draft !== undefined) {
    const date = dateOf(draft);
    if (date !== undefined && date?.date === value?.date) setDraft(undefined);
  }
  const typed = draft ?? typedDate(value);
  const setTyped = setDraft;
  const done = () => {
    if (draft === undefined) return;
    const date = dateOf(draft);
    const now =
      date === undefined ? "Give a year, and a month with a day." : undefined;
    setProblem(now);
    report(now);
    if (date !== undefined && date?.date !== value?.date) commit(date);
  };
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      onBlur={(event) => {
        if (leaves(event)) done();
      }}
    >
      <legend className="mb-1.5 font-medium">Birth date</legend>
      <div className="flex gap-2">
        <input
          id={`${id}-day`}
          aria-label="Day"
          inputMode="numeric"
          placeholder="Day"
          value={typed.day}
          onChange={(event) => {
            setTyped({
              ...typed,
              day: event.target.value.replace(/\D/g, "").slice(0, 2),
            });
          }}
          className="w-16 rounded-lg border border-line bg-surface px-2 py-1.5"
        />
        <select
          aria-label="Month"
          value={typed.month}
          onChange={(event) => {
            setTyped({ ...typed, month: event.target.value });
          }}
          className="w-36 rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="">Month</option>
          {MONTHS.map((name, n) => (
            <option key={name} value={String(n + 1)}>
              {name}
            </option>
          ))}
        </select>
        <input
          aria-label="Year"
          inputMode="numeric"
          placeholder="Year"
          value={typed.year}
          onChange={(event) => {
            setTyped({
              ...typed,
              year: event.target.value.replace(/\D/g, "").slice(0, 4),
            });
          }}
          className="w-20 rounded-lg border border-line bg-surface px-2 py-1.5"
        />
      </div>
      <p className="text-muted">
        {problem ?? "The year at least; the day and month if you like."}
      </p>
    </fieldset>
  );
}

interface TypedHeight {
  number: string;
  unit: "cm" | "in";
}

/** What was typed as a height; null when emptied, undefined when not a number. */
function heightOf(typed: TypedHeight): ProfileValues["height"] | undefined {
  if (typed.number.trim() === "") return null;
  const number = Number(typed.number);
  return Number.isFinite(number) && number > 0
    ? { value: number, unit: typed.unit }
    : undefined;
}

/** Whether a typed height is the one saved; an empty one only in the unit shown for none. */
const sameHeight = (typed: TypedHeight, value: ProfileValues["height"]) => {
  const height = heightOf(typed);
  return height === null
    ? value === null && typed.unit === "cm"
    : height !== undefined &&
        height.value === value?.value &&
        height.unit === value.unit;
};

/**
 * A height, a number and its unit; saved when focus leaves it changed,
 * cleared when emptied.
 */
function Height({
  id,
  value,
  commit,
  report,
}: {
  id: string;
  value: ProfileValues["height"];
  commit: (value: ProfileValues["height"]) => void;
  report: (problem: string | undefined) => void;
}) {
  // What you typed, until the profile has it; untouched, the field shows the profile.
  const [draft, setDraft] = useState<TypedHeight>();
  const [problem, setProblem] = useState<string>();
  if (draft !== undefined && sameHeight(draft, value)) setDraft(undefined);
  const typed = draft ?? {
    number: value === null ? "" : String(value.value),
    unit: value?.unit ?? "cm",
  };
  const setTyped = setDraft;
  const done = () => {
    if (draft === undefined) return;
    const height = heightOf(draft);
    const now =
      height === undefined ? "Give your height as a number." : undefined;
    setProblem(now);
    report(now);
    if (height === null ? value !== null : height !== undefined) {
      commit(height ?? null);
    }
  };
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      onBlur={(event) => {
        if (leaves(event)) done();
      }}
    >
      <legend className="mb-1.5 font-medium">
        Height <span className="font-normal text-muted">optional</span>
      </legend>
      <div className="flex gap-2">
        <input
          id={id}
          aria-label="Height"
          inputMode="decimal"
          placeholder="Height"
          value={typed.number}
          onChange={(event) => {
            setTyped({ ...typed, number: event.target.value });
          }}
          className="w-24 rounded-lg border border-line bg-surface px-2 py-1.5"
        />
        <select
          aria-label="Unit"
          value={typed.unit}
          onChange={(event) => {
            setTyped({
              ...typed,
              unit: event.target.value as TypedHeight["unit"],
            });
          }}
          className="w-20 rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="cm">cm</option>
          <option value="in">in</option>
        </select>
      </div>
      {problem && <p className="text-muted">{problem}</p>}
    </fieldset>
  );
}

/**
 * The form, saving each field as it is committed, from the profile page or
 * Settings (`in`). One save at a time, so the last change is the one kept.
 * A change shows until it is saved, and one that fails stays, with why and
 * Retry. On the page, Done closes the form once nothing is left unsaved.
 */
function SavedFields({
  personId,
  values,
  in: where,
  done,
}: {
  personId: string;
  values: ProfileValues;
  in: "profile" | "settings";
  done?: () => void;
}) {
  const save = useMutation({
    scope: { id: `profile-${personId}` },
    mutationFn: (changes: Partial<ProfileValues>) =>
      saveProfile(personId, {
        sending: crypto.randomUUID(),
        in: where,
        changes,
      }),
  });
  // Changes sent and not saved yet, shown over the profile; kept when they fail.
  const [unsaved, setUnsaved] = useState<Partial<ProfileValues>>({});
  const [failure, setFailure] = useState<Error>();
  const sending = useRef<{
    unsaved: Partial<ProfileValues>;
    saves: Set<Promise<unknown>>;
    problems: Map<ProfileField, string>;
  }>({ unsaved: {}, saves: new Set(), problems: new Map() });
  const keep = (next: Partial<ProfileValues>) => {
    sending.current.unsaved = next;
    setUnsaved(next);
  };
  const send = (changes: Partial<ProfileValues>) => {
    keep({ ...sending.current.unsaved, ...changes });
    const saved = save.mutateAsync(changes).then(
      () => {
        // A field changed again since keeps its newer value.
        const left = Object.fromEntries(
          Object.entries(sending.current.unsaved).filter(
            ([field, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(changes[field as ProfileField]),
          ),
        );
        keep(left);
        if (Object.keys(left).length === 0) setFailure(undefined);
      },
      (error: unknown) => {
        setFailure(error instanceof Error ? error : new Error(String(error)));
      },
    );
    sending.current.saves.add(saved);
    void saved.finally(() => sending.current.saves.delete(saved));
    return saved;
  };
  const retry = () => send(sending.current.unsaved);
  const finish = async () => {
    await Promise.all(sending.current.saves);
    if (sending.current.problems.size > 0) return;
    if (Object.keys(sending.current.unsaved).length > 0) await retry();
    if (Object.keys(sending.current.unsaved).length === 0) done?.();
  };
  return (
    <div className="flex flex-col gap-3">
      <ProfileFields
        values={{ ...values, ...unsaved }}
        commit={(field, value) => {
          void send({ [field]: value });
        }}
        report={(field, problem) => {
          if (problem === undefined) sending.current.problems.delete(field);
          else sending.current.problems.set(field, problem);
        }}
      />
      {failure && Object.keys(unsaved).length > 0 && (
        <Problem
          error={failure}
          retry={() => {
            void retry();
          }}
        />
      )}
      {done && (
        <div>
          <Button
            icon={Check}
            onClick={() => {
              void finish();
            }}
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

/** Settings › Profile: the same form as the page, its changes "in Settings". */
export function ProfileSection({ person }: { person: Person }) {
  const profile = useProfile(person.id);
  return (
    <>
      <h2 id="profile" className="mt-8 mb-2 px-0.5 font-semibold">
        Profile
      </h2>
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        {profile.data === undefined ? (
          profile.error && (
            <Problem
              error={profile.error}
              retry={() => void profile.refetch()}
            />
          )
        ) : (
          <SavedFields
            personId={person.id}
            values={profile.data.values}
            in="settings"
          />
        )}
        <p className="text-muted">
          A change saves at once, and goes in your profile's history. The AI
          reads your profile with your health record.
        </p>
      </div>
    </>
  );
}

/** One line of the history: when, what changed, and where. */
function ChangeLine({ change, now }: { change: ProfileChange; now: Date }) {
  return (
    <li className="py-0.5">
      <span className="text-muted">{savedAt(change.at, now)}</span> ·{" "}
      {change.fields
        .map(
          (field) =>
            `${FIELD_NAMES[field.field]} ${shownValue(field.field, field.before)} → ${shownValue(field.field, field.after)}`,
        )
        .join("; ")}{" "}
      · <span className="text-muted">{MADE_IN[change.madeIn]}</span>
    </li>
  );
}

function Row({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 border-t border-line py-2 first:border-t-0">
      <dt className="w-40 shrink-0 text-muted">{name}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** Your profile's page: each value, your age, Edit, and the history. */
export function ProfilePage({ person }: { person: Person }) {
  const profile = useProfile(person.id);
  const [editing, setEditing] = useState(false);
  const [now] = useState(() => new Date());
  if (profile.data === undefined) {
    return (
      <div className="mx-auto max-w-[620px] px-6 py-8">
        {profile.error && (
          <Problem error={profile.error} retry={() => void profile.refetch()} />
        )}
      </div>
    );
  }
  const { values, age, history } = profile.data;
  return (
    <div className="mx-auto max-w-[620px] px-6 py-8">
      <div className="rounded-xl border border-line bg-surface p-4">
        {editing ? (
          <SavedFields
            personId={person.id}
            values={values}
            in="profile"
            done={() => {
              setEditing(false);
            }}
          />
        ) : (
          <>
            <dl>
              <Row name="Name">{person.displayName}</Row>
              {(Object.keys(FIELD_NAMES) as ProfileField[]).map((field) => (
                <Row key={field} name={FIELD_NAMES[field]}>
                  <span className={values[field] === null ? "text-muted" : ""}>
                    {shownValue(field, values[field])}
                  </span>
                  {field === "birth_date" && age !== null && (
                    <span className="text-muted"> · {ageText(age)}</span>
                  )}
                </Row>
              ))}
            </dl>
            <div className="mt-3">
              <Button
                icon={Pencil}
                onClick={() => {
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            </div>
          </>
        )}
      </div>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">History</h2>
      <div className="rounded-xl border border-line bg-surface p-4">
        {history.length === 0 ? (
          <p className="text-muted">No changes yet.</p>
        ) : (
          <ol>
            {history.toReversed().map((change) => (
              <ChangeLine key={change.save} change={change} now={now} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
