// The first run, for a new data folder: what Rufi is and isn't, what goes to
// the AI, your name, sign-in, the emergency region. The core keeps what is
// done, so a reload or another tab continues at the first step not done.
import {
  type AddPerson,
  type FinishStep,
  FirstRun as FirstRunAnswer,
  type SaveSettings,
  Person,
  Settings,
} from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Schema } from "effect";
import { type ReactNode, useState } from "react";
import { ApiError, read } from "./api.ts";
import { queries, useFirstRun, useSettings } from "./reads.ts";
import { SignIn } from "./signin.tsx";
import { Button, Problem } from "./ui.tsx";

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
      return <YourName />;
    case "sign_in":
      return (
        <Step title="Sign in with ChatGPT">
          <SignIn skip={() => void finish("sign_in")} />
        </Step>
      );
    case "region":
      return <EmergencyRegion />;
    case "done":
      return null;
  }
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby="step"
      className="mx-auto mt-24 flex max-w-md flex-col gap-3 px-6"
    >
      <h2 id="step" className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Welcome() {
  const [understood, setUnderstood] = useState(false);
  const done = useMutation({ mutationFn: () => finish("welcome") });
  return (
    <Step title="Welcome to Rufi">
      <p>
        What you ask, and the parts of your record the AI reads to answer, are
        sent to the AI in the cloud. Your record is kept on your Mac.
      </p>
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
      {done.error && (
        <p role="alert" className="text-muted">
          {done.error.message}
        </p>
      )}
      <Button
        look="main"
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

function YourName() {
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: (displayName: string) =>
      read(Added, "POST", "/api/people", {
        displayName,
      } satisfies typeof AddPerson.Type),
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
  return (
    <form
      className="mx-auto mt-24 flex max-w-md flex-col gap-3 px-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "") add.mutate(trimmed);
      }}
    >
      <label htmlFor="name" className="text-xl font-semibold">
        What's your name?
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
        className="rounded-lg border border-line bg-white px-3 py-2"
      />
      {add.error && (
        <p role="alert" className="text-muted">
          {add.error.message}
        </p>
      )}
      <Button
        type="submit"
        look="main"
        className="self-start"
        disabled={trimmed === "" || add.isPending}
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
      if (chosen !== null) {
        queries.setQueryData(
          ["settings"],
          await read(Settings, "PUT", "/api/settings", {
            emergencyRegion: chosen,
          } satisfies typeof SaveSettings.Type),
        );
      }
      await finish("region");
    },
  });
  return (
    <Step title="Your emergency region">
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
          className="w-64 rounded-lg border border-line bg-white px-2 py-1.5"
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
          disabled={region === "" || done.isPending}
          onClick={() => {
            done.mutate(region);
          }}
        >
          Continue
        </Button>
        <Button
          disabled={done.isPending}
          onClick={() => {
            done.mutate(null);
          }}
        >
          Skip
        </Button>
      </div>
    </Step>
  );
}
