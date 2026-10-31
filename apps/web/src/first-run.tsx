// The first run, for a new data folder: what Rufi is and isn't, what goes to
// the AI, and how Rufi looks; about you (your name and profile), sign-in,
// the emergency region. The core keeps what is
// done, so a reload or another tab continues at the first step not done.
import {
  type AddPerson,
  type FinishStep,
  FirstRun as FirstRunAnswer,
  Person,
} from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Schema } from "effect";
import { ArrowRight, Check } from "lucide-react";
import type { ProfileValues } from "@rufi/contracts/record";
import type { ExpressionKey } from "@rufi/brand/mark";
import { type ReactNode, useState } from "react";
import { ApiError, read } from "./api.ts";
import { AppearanceChoice } from "./appearance.tsx";
import { LiveDog } from "./dog.tsx";
import { ProfileFields } from "./profile.tsx";
import { queries, saveSettings, useFirstRun, useSettings } from "./reads.ts";
import { SignIn, useSignInFlow } from "./signin.tsx";
import { Button, ICON, Problem } from "./ui.tsx";

const Added = Schema.Struct({ person: Person });

/** Marks a step done; the answer is the next step. */
const finish = async (step: typeof FinishStep.Type.step) => {
  const next = await read(FirstRunAnswer, "POST", "/api/first-run", {
    step,
  } satisfies typeof FinishStep.Type);
  queries.setQueryData(["first-run"], next);
};

export function FirstRun() {
  const firstRun = useFirstRun();
  if (firstRun.data === undefined) {
    return firstRun.error ? (
      <div className="px-6 py-8">
        <Problem error={firstRun.error} retry={() => void firstRun.refetch()} />
      </div>
    ) : null;
  }
  switch (firstRun.data.step) {
    case "welcome":
      return <Welcome />;
    case "name":
      return <AboutYou />;
    case "sign_in":
      return <SignInStep />;
    case "region":
      return <EmergencyRegion />;
    case "done":
      return null;
  }
}

/** The steps in order, for the marker at the top of each. */
const STEPS = ["welcome", "name", "sign_in", "region"] as const;

function Step({
  step,
  title,
  mood = "hello",
  children,
}: {
  step: (typeof STEPS)[number];
  title: string;
  mood?: ExpressionKey;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="step"
      className="mx-auto mt-16 flex max-w-md flex-col gap-3 px-6"
    >
      <StepTop step={step} mood={mood} />
      <h1 id="step" className="text-xl font-semibold">
        {title}
      </h1>
      {children}
    </section>
  );
}

/** Where you are in the first run, and Rufi with a face for the step. */
function StepTop({
  step,
  mood,
}: {
  step: (typeof STEPS)[number];
  mood: ExpressionKey;
}) {
  const at = STEPS.indexOf(step);
  return (
    <>
      <div
        role="img"
        aria-label={`Step ${String(at + 1)} of ${String(STEPS.length)}`}
        className="flex items-center gap-1"
      >
        {STEPS.map((one, i) => (
          <span
            key={one}
            className={`h-1 rounded-full ${i === at ? "w-4.5 bg-accent" : "w-1 bg-line"}`}
          />
        ))}
      </div>
      <div className="mt-4 mb-1">
        <LiveDog mood={mood} size={64} />
      </div>
    </>
  );
}

function Welcome() {
  const [understood, setUnderstood] = useState(false);
  const done = useMutation({ mutationFn: () => finish("welcome") });
  return (
    <Step step="welcome" title="Welcome to Rufi">
      <p>
        Rufi uses AI. What you ask, the documents you send and the parts of your
        health record the AI reads go to the AI provider you sign in with. Your
        health record is kept on your Mac.
      </p>
      <div className="my-1 flex items-center gap-3">
        <Place name="Your Mac">Your health record</Place>
        <ArrowRight size={ICON} className="shrink-0 text-muted" aria-hidden />
        <Place name="The AI provider">
          What you ask, the documents you send, the parts the AI reads
        </Place>
      </div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={understood}
          onChange={(event) => {
            setUnderstood(event.target.checked);
          }}
        />
        I understand Rufi is not a doctor
      </label>
      <AppearanceChoice />
      {done.error && (
        <p role="alert" className="text-muted">
          {done.error.message}
        </p>
      )}
      <Button
        look="main"
        icon={ArrowRight}
        className="self-start"
        disabled={!understood || done.isPending}
        onClick={() => {
          done.mutate();
        }}
      >
        Continue
      </Button>
    </Step>
  );
}

/**
 * "About you": your name, birth date and sex, needed to go on, and your
 * blood group and height, which can stay empty. All of it is saved together
 * with you and your chat, or nothing is; on a failure what you entered
 * stays, with one line on what to do.
 */
function AboutYou() {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<ProfileValues>({
    birth_date: null,
    sex_for_ranges: null,
    blood_group: null,
    height: null,
  });
  const add = useMutation({
    mutationFn: (about: typeof AddPerson.Type) =>
      read(Added, "POST", "/api/people", about),
    onSettled: (_added, error) => {
      // Added here or in another tab: either way, on to the next step.
      if (
        error === null ||
        (error instanceof ApiError && error.status === 409)
      ) {
        void queries.invalidateQueries({ queryKey: ["people"] });
        void queries.invalidateQueries({ queryKey: ["first-run"] });
      }
    },
  });
  const trimmed = name.trim();
  const { birth_date, sex_for_ranges, blood_group, height } = profile;
  const ready =
    trimmed !== "" && birth_date !== null && sex_for_ranges !== null;
  return (
    <form
      aria-labelledby="step"
      className="mx-auto mt-16 mb-16 flex max-w-md flex-col gap-3 px-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        add.mutate({
          displayName: trimmed,
          profile: {
            birth_date,
            sex_for_ranges,
            ...(blood_group !== null && { blood_group }),
            ...(height !== null && { height }),
          },
        });
      }}
    >
      <StepTop step="name" mood="hello" />
      <h1 id="step" className="text-xl font-semibold">
        About you
      </h1>
      <p className="text-muted">
        Rufi uses your age and sex to choose the right lab ranges.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="font-medium">
          Name
        </label>
        <input
          id="name"
          autoFocus
          autoComplete="given-name"
          maxLength={200}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="rounded-lg border border-line bg-surface px-3 py-2"
        />
      </div>
      <ProfileFields
        values={profile}
        asTyped
        commit={(field, value) => {
          setProfile((now) => ({ ...now, [field]: value }));
        }}
      />
      {add.error && (
        <p role="alert" className="text-muted">
          {add.error.message} Nothing was saved, and your answers are still
          here: click Continue to try again.
        </p>
      )}
      <Button
        type="submit"
        look="main"
        icon={ArrowRight}
        className="self-start"
        disabled={!ready || add.isPending}
      >
        Continue
      </Button>
    </form>
  );
}

function EmergencyRegion() {
  const settings = useSettings();
  const [region, setRegion] = useState("");
  const done = useMutation({
    mutationFn: async (chosen: string | null) => {
      if (chosen !== null) await saveSettings({ emergencyRegion: chosen });
      await finish("region");
    },
  });
  return (
    <Step step="region" title="Your emergency region" mood="calm">
      <p className="text-muted">
        The AI gives this number when a message may describe an emergency. Not
        set: it says to call your local emergency number. You can change it in
        Settings.
      </p>
      {settings.data === undefined && settings.error ? (
        <Problem error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <select
          aria-label="Emergency region"
          value={region}
          onChange={(event) => {
            setRegion(event.target.value);
          }}
          className="w-64 rounded-lg border border-line bg-surface px-2 py-1.5"
        >
          <option value="">Not set</option>
          {settings.data?.regions.map((r) => (
            <option key={r.region} value={r.region}>
              {r.name} ({r.number})
            </option>
          ))}
        </select>
      )}
      {done.error && (
        <p role="alert" className="text-muted">
          {done.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          look="main"
          icon={Check}
          disabled={region === "" || done.isPending}
          onClick={() => {
            done.mutate(region);
          }}
        >
          Save and continue
        </Button>
        <Button
          icon={ArrowRight}
          disabled={done.isPending}
          onClick={() => {
            done.mutate(null);
          }}
        >
          Skip for now
        </Button>
      </div>
    </Step>
  );
}

/** One side of where your things are, in the welcome step. */
function Place({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex-1 rounded-xl border border-line bg-surface px-3 py-2">
      <p className="font-semibold">{name}</p>
      <p>{children}</p>
    </div>
  );
}

/** Sign in, with Rufi thinking while ChatGPT's sign-in waits. */
function SignInStep() {
  const waiting = useSignInFlow().data?.state === "waiting";
  return (
    <Step
      step="sign_in"
      title="Sign in with ChatGPT"
      mood={waiting ? "thinking" : "hello"}
    >
      <SignIn provider="codex" skip={() => void finish("sign_in")} />
    </Step>
  );
}
