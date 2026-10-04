// With nobody in the data folder yet: the one question Rufi asks first.
import { type AddPerson, Person } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { read } from "./api.ts";
import { queries } from "./reads.ts";
import { Button } from "./ui.tsx";

const Added = Schema.Struct({ person: Person });

export function FirstRun() {
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: (displayName: string) =>
      read(Added, "POST", "/api/people", {
        displayName,
      } satisfies typeof AddPerson.Type),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["people"] }),
  });
  const trimmed = name.trim();
  return (
    <form
      className="mx-auto mt-24 flex max-w-sm flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "") add.mutate(trimmed);
      }}
    >
      <label htmlFor="name" className="text-xl font-semibold">
        What's your name?
      </label>
      <p className="text-muted">Rufi keeps your health record on this Mac.</p>
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
