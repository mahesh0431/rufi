// A provider in memory, for the package's own tests: it stands in for an
// adapter and keeps the boundary's contract (tests/contract.ts) as the real
// ones do. What it does is set by a Script, which a test may change at any
// time, and a turn that runs ends when the test ends it.
import { randomUUID } from "node:crypto";
import {
  Missing,
  NotOpened,
  type Conversation,
  type Delivery,
  type Family,
  type Input,
  type OpenOptions,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderModel,
  type SteerOutcome,
  type TurnEnd,
} from "../src/provider.ts";
import type { Script } from "./contract.ts";

export interface FakeProvider {
  adapter: ProviderAdapter;
  /** How the provider behaves from now on. */
  script: Script;
  /** Ends a conversation's running turn: done with the answer, by default. */
  end: (ref: string, end?: TurnEnd) => void;
  /** The inputs the provider received in a conversation, in order. */
  received: (ref: string) => readonly Input[];
}

interface Running {
  turn: string;
  /** Steers the provider holds until the turn ends. */
  held: { input: Input; answer: (outcome: SteerOutcome) => void }[];
}

/** A conversation as the provider keeps it, across opens. */
interface Kept {
  received: Input[];
  /** The open handle's events and running turn, while it is open. */
  open?: { onEvent: (event: ProviderEvent) => void; running?: Running };
}

const MODELS: readonly ProviderModel[] = [
  {
    id: "fake-model",
    name: "Fake model",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

export function fakeProvider(
  options: {
    id?: string;
    family?: Family;
    models?: readonly ProviderModel[];
    script?: Script;
    /** What every turn that ends normally answers. */
    answer?: string;
  } = {},
): FakeProvider {
  const answer = options.answer ?? "Done.";
  const kept = new Map<string, Kept>();
  let turns = 0;
  const fake: FakeProvider = {
    adapter: {
      id: options.id ?? "fake",
      family: options.family ?? "openai",
      models: () => Promise.resolve(options.models ?? MODELS),
      open: (open) => Promise.resolve().then(() => conversation(open)),
      usage: () => Promise.resolve([]),
      close: () => {
        for (const [ref, conversation] of kept) {
          if (conversation.open?.running) {
            finish(ref, { status: "stopped" });
          }
          delete conversation.open;
        }
        return Promise.resolve();
      },
    },
    script: options.script ?? {},
    end: (ref, end = { status: "done", answer }) => {
      finish(ref, end);
    },
    received: (ref) => kept.get(ref)?.received ?? [],
  };

  const emit = (ref: string, event: ProviderEvent) => {
    kept.get(ref)?.open?.onEvent(event);
  };

  function begin(ref: string, inputs: readonly string[]): string {
    const open = kept.get(ref)?.open;
    if (!open) throw new Error("The conversation isn't open.");
    turns += 1;
    const turn = `turn-${String(turns)}`;
    open.running = { turn, held: [] };
    emit(ref, { type: "turnStarted", turn, inputs });
    return turn;
  }

  /** What a turn does once it has started, after the start has answered. */
  function run(ref: string, turn: string): void {
    const now = () => kept.get(ref)?.open?.running?.turn === turn;
    setTimeout(() => {
      if (!now()) return;
      switch (fake.script.turn ?? "answers") {
        case "runs":
          return;
        case "fails":
          finish(ref, {
            status: "failed",
            reason: "other",
            text: "The fake provider failed.",
          });
          return;
        case "usage_limit":
          finish(ref, {
            status: "failed",
            reason: "usage_limit",
            text: "The fake provider's usage limit was reached.",
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
          return;
        case "dies":
          finish(ref, { status: "failed", reason: "process_died" });
          return;
        case "renewal_fails":
          finish(ref, { status: "failed", reason: "signed_out" });
          return;
        // It has no sign-in to renew, and no limits.
        case "answers":
        case "silent":
        case "renews":
          if (fake.script.picture !== undefined) {
            emit(ref, {
              type: "step",
              turn,
              item: `${turn}-picture`,
              kind: "tool",
              title: "get_page",
              status: "done",
              payload: { result: [{ type: "image", data: "(not kept)" }] },
            });
          }
          emit(ref, {
            type: "text",
            turn,
            item: `${turn}-answer`,
            delta: answer,
          });
          emit(ref, {
            type: "text",
            turn,
            item: `${turn}-answer`,
            delta: "",
            done: true,
          });
          finish(ref, { status: "done", answer });
      }
    });
  }

  /** The running turn ends: told once; a steer it held goes with it. */
  function finish(ref: string, end: TurnEnd): void {
    const open = kept.get(ref)?.open;
    const running = open?.running;
    if (!open || !running) return;
    delete open.running;
    for (const { input, answer: reply } of running.held) {
      if (end.status === "done") {
        kept.get(ref)?.received.push(input);
        reply({ status: "delivered" });
      } else {
        reply({ status: "not_delivered", text: "The turn ended first." });
      }
    }
    emit(ref, { type: "turnEnded", turn: running.turn, end });
  }

  function conversation(options: OpenOptions): Conversation {
    if (options.resume !== undefined && !kept.has(options.resume)) {
      throw new Missing("The fake provider has no such conversation.");
    }
    if (options.resume !== undefined && fake.script.resumeFails) {
      throw new NotOpened("The fake provider couldn't open it now.");
    }
    const ref = options.resume ?? randomUUID();
    const mine: Kept = kept.get(ref) ?? { received: [] };
    kept.set(ref, mine);
    const open: NonNullable<Kept["open"]> = { onEvent: options.onEvent };
    mine.open = open;
    const isOpen = () => mine.open === open;
    const running = () => (isOpen() ? open.running : undefined);

    return {
      ref,

      startTurn: (start): Promise<Delivery> => {
        if (!isOpen()) {
          return Promise.resolve({
            status: "not_delivered",
            text: "The conversation is closed.",
          });
        }
        if (open.running) {
          return Promise.resolve({
            status: "not_delivered",
            text: "A turn is running.",
          });
        }
        if (fake.script.signedIn === false) {
          return Promise.resolve({
            status: "not_delivered",
            reason: "signed_out",
            text: "Signed out of the fake provider.",
          });
        }
        const taken = fake.script.start ?? "takes";
        if (taken === "refuses") {
          return Promise.resolve({
            status: "not_delivered",
            text: "The fake provider refused it.",
          });
        }
        mine.received.push(start.input);
        run(ref, begin(ref, [start.input.id]));
        return Promise.resolve(
          taken === "loses_reply"
            ? {
                status: "uncertain",
                text: "The fake provider's reply was lost.",
              }
            : { status: "delivered" },
        );
      },

      steer: ({ input, turn }): Promise<SteerOutcome> => {
        const now = running();
        if (now?.turn !== turn) {
          return Promise.resolve({
            status: "not_delivered",
            text: "That turn has ended.",
          });
        }
        switch (fake.script.steer ?? "takes") {
          case "takes":
            mine.received.push(input);
            return Promise.resolve({ status: "delivered" });
          case "loses_reply":
            mine.received.push(input);
            return Promise.resolve({
              status: "uncertain",
              text: "The fake provider's reply was lost.",
            });
          case "holds":
            return new Promise((resolve) => {
              now.held.push({ input, answer: resolve });
            });
          case "starts_next": {
            finish(ref, { status: "done", answer });
            mine.received.push(input);
            const next = begin(ref, [input.id]);
            run(ref, next);
            return Promise.resolve({ status: "next_turn", turn: next });
          }
        }
      },

      // Whether or not it obeys an interrupt, the fake's turn ends at once.
      stop: (turn) => {
        if (running()?.turn === turn) finish(ref, { status: "stopped" });
        return Promise.resolve();
      },

      reconcile: (ids) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              mine.received.some((input) => input.id === id)
                ? "received"
                : "not_received",
            ]),
          ),
        ),

      placeCall: (meta) => {
        const fields = (meta ?? {}) as Record<string, unknown>;
        const turn = running()?.turn;
        const call = fields["fake/call"];
        return turn !== undefined &&
          fields["fake/turn"] === turn &&
          typeof call === "string"
          ? { turn, call }
          : undefined;
      },

      close: () => {
        if (running()) finish(ref, { status: "stopped" });
        if (isOpen()) delete mine.open;
        return Promise.resolve();
      },
    };
  }

  return fake;
}
