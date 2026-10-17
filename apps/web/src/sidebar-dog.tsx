// The dog at the top of the sidebar: its face says what Rufi is doing
// (mood.ts), from what the frame already reads: the connection, the
// sign-in, the person's chat as its live stream holds it (with the face
// Rufi's AI chose in its reply) and the readings. It reads nothing new and
// keeps nothing.
import { Face, type Person, type Turn } from "@rufi/contracts";
import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useConnection } from "./api.ts";
import { Dog } from "./dog.tsx";
import { liveStore, type Live } from "./live.ts";
import { moodOf } from "./mood.ts";
import { useReadings } from "./reading.tsx";
import { useStatus } from "./reads.ts";
import { isRunning } from "./transcript-state.ts";

/** How long the dog shows a job just finished. */
const DONE_MS = 3_000;

/** The show_face call's line in Activity, as the agent reports it. */
const FACE_TOOL = "rufi.show_face";

const faceOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ face: Face })),
);

/** The reply that started last, if any. */
const lastTurn = (state: Live): Turn | undefined =>
  Object.values(state.turns).reduce<Turn | undefined>(
    (last, turn) =>
      last === undefined || turn.startedAt > last.startedAt ? turn : last,
    undefined,
  );

/** The face Rufi's AI showed last in its latest reply, if it showed one. */
function chosenFace(state: Live): Face | undefined {
  const turn = lastTurn(state);
  if (turn === undefined) return undefined;
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[state.order[i] ?? ""];
    if (
      entry?.turnId === turn.id &&
      entry.activity === "tool" &&
      entry.text === FACE_TOOL &&
      entry.status === "done"
    ) {
      const shown = faceOf(entry.detail ?? "");
      if (Option.isSome(shown)) return shown.value.face;
    }
  }
  return undefined;
}

export function SidebarDog({ person }: { person: Person }) {
  const connection = useConnection();
  const account = useStatus().data?.account;
  const live = liveStore(person.id);
  const working = useStore(live, isRunning);
  const turn = useStore(live, lastTurn);
  const chosen = useStore(live, chosenFace);
  const emptyChat = useStore(
    live,
    (state) => state.status === "open" && state.order.length === 0,
  );
  const reading =
    useReadings(person.id).data?.some((one) => one.state === "running") ===
    true;

  // A reply or a reading that ended: done for a few seconds. A reply the
  // person stopped, or one that broke off, isn't done.
  const busy = working || reading;
  const wasBusy = useRef(busy);
  const [justDone, setJustDone] = useState(false);
  useEffect(() => {
    const finished =
      wasBusy.current &&
      !busy &&
      lastTurn(live.getState())?.status !== "interrupted";
    wasBusy.current = busy;
    if (!finished) return;
    setJustDone(true);
    const over = setTimeout(() => {
      setJustDone(false);
    }, DONE_MS);
    return () => {
      clearTimeout(over);
      setJustDone(false);
    };
  }, [busy, live]);

  const mood = moodOf({
    away:
      connection !== "ok" || (account !== undefined && account !== "signed_in"),
    failed:
      turn !== undefined &&
      (turn.status === "failed" ||
        (turn.status === "interrupted" && turn.endReason !== "stopped")),
    chosen,
    reading,
    working,
    justDone,
    emptyChat,
  });
  return <Dog mood={mood} size={36} />;
}
