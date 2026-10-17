// The dog at the top of the sidebar: its face says what Rufi is doing
// (mood.ts), from what the frame already reads: the sign-in, the person's
// chat as its live stream holds it, the readings and Overview. It reads
// nothing new and keeps nothing.
import type { Person, Turn } from "@rufi/contracts";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Dog } from "./dog.tsx";
import { liveStore, type Live } from "./live.ts";
import { moodOf } from "./mood.ts";
import { useReadings } from "./reading.tsx";
import { useOverview, useStatus } from "./reads.ts";
import { isRunning } from "./transcript-state.ts";

/** How long the dog shows a job just finished. */
const DONE_MS = 3_000;

/** The reply that started last, if any. */
const lastTurn = (state: Live): Turn | undefined =>
  Object.values(state.turns).reduce<Turn | undefined>(
    (last, turn) =>
      last === undefined || turn.startedAt > last.startedAt ? turn : last,
    undefined,
  );

export function SidebarDog({
  person,
  seeing,
}: {
  person: Person;
  /** The page shows the person's due follow-ups (Overview, Follow-ups). */
  seeing: boolean;
}) {
  const account = useStatus().data?.account;
  const live = liveStore(person.id);
  const working = useStore(live, isRunning);
  const turn = useStore(live, lastTurn);
  const emptyChat = useStore(
    live,
    (state) => state.status === "open" && state.order.length === 0,
  );
  const needsYou = useStore(live, (state) =>
    state.queue.items.some(
      (item) =>
        item.origin === "person" &&
        (item.state === "not_sure" || item.held !== null),
    ),
  );
  const reading =
    useReadings(person.id).data?.some((one) => one.state === "running") ===
    true;
  const due = (useOverview(person.id).data?.needsYou.followUps ?? [])
    .filter((need) => need.state !== "coming_up")
    .map((need) => need.followUp.id);

  // A follow-up due counts as seen once a page showed it.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const unseen = due.filter((id) => !seen.has(id));
  if (seeing && unseen.length > 0) setSeen(new Set([...seen, ...unseen]));

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
    signedOut: account !== undefined && account !== "signed_in",
    failed:
      turn !== undefined &&
      (turn.status === "failed" ||
        (turn.status === "interrupted" && turn.endReason !== "stopped")),
    needsYou,
    reading,
    working,
    justDone,
    newNotice: !seeing && unseen.length > 0,
    emptyChat,
  });
  return <Dog mood={mood} size={36} />;
}
