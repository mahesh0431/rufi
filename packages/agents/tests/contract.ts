// The provider boundary's contract: one suite that every adapter runs, on
// its own fixtures, through a harness that makes its provider behave as each
// case needs. What the agent system relies on is checked here once, so no
// part of it has to know which provider runs an agent.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  Missing,
  NotOpened,
  type Conversation,
  type Input,
  type OpenOptions,
  type ProviderAdapter,
  type ProviderEvent,
  type TurnEnd,
} from "../src/provider.ts";

/** What the provider answers whenever a turn ends normally. */
export const ANSWER = "Asha's TSH was 5.8 mIU/L on 12 March.";

/** How the provider behaves in a case; anything not said is the default. */
export interface Script {
  /** Its sign-in is there (the default), or not. */
  signedIn?: boolean;
  /** A resume of a conversation it has fails, as if it couldn't open now. */
  resumeFails?: boolean;
  /** A turn's start: taken (the default), refused, or taken with its reply lost. */
  start?: "takes" | "refuses" | "loses_reply";
  /**
   * What a turn does once started. Answers: ANSWER at once (the default).
   * Runs: until stopped. Silent: longer than any limit the adapter has, then
   * answers. Fails, or hits the usage limit (with a reset time), or its
   * process dies. Renews: its sign-in is renewed during it, then it answers.
   * Renewal fails: its sign-in can't be renewed during it.
   */
  turn?:
    | "answers"
    | "runs"
    | "silent"
    | "fails"
    | "usage_limit"
    | "dies"
    | "renews"
    | "renewal_fails";
  /**
   * A steer into a running turn: taken (the default), taken with its reply
   * lost, held until the turn ends (taken if it ends normally), or taken
   * as the start of the next turn as the running one ends.
   */
  steer?: "takes" | "loses_reply" | "holds" | "starts_next";
  /** It ignores an interrupt. */
  ignoresInterrupt?: boolean;
  /** Before it answers, a step whose result holds a picture: these bytes, base64. */
  picture?: string;
}

/** One case's adapter, and how its conversations open. */
export interface Setup {
  adapter: ProviderAdapter;
  options: Pick<OpenOptions, "cwd" | "model" | "effort" | "tools">;
  /** Ends what the harness started beside the adapter. */
  close?: () => Promise<void>;
}

const CASES = {
  models:
    "lists its models with their efforts; a default effort is one of them",
  resume: "resumes a conversation by its reference, and it goes on",
  missing: "a resume that finds nothing is Missing",
  notOpened: "a resume that fails otherwise is NotOpened",
  turn: "a turn's events come between its start and end, and it ends done with its answer",
  refused: "a refused start is not delivered, and no turn starts",
  signedOut: "signed out, an input is never delivered, and the reason says so",
  lostStart:
    "a start whose reply is lost is uncertain, and reconcile tells what arrived",
  steer: "a steer into the running turn is delivered",
  lateSteer:
    "a steer for a turn that ended isn't delivered, and starts nothing",
  lostSteer: "a steer whose reply is lost is uncertain, and reconcile finds it",
  nextTurn: "a steer that started the next turn is named in that turn's start",
  heldSteer: "Stop answers a steer the provider held as not delivered",
  stop: "Stop ends the turn as stopped, and nothing of it comes after",
  stuck: "Stop ends a turn whose provider ignores the interrupt",
  fails: "a failed turn ends failed, with the provider's words",
  usageLimit: "a usage limit ends the turn failed, with when it resets",
  dies: "a provider process that dies ends the turn failed: process died",
  renews: "a turn that crosses a sign-in renewal ends done",
  renewalFails:
    "a renewal that fails ends the turn signed out, and the input isn't sent again",
  noLimit: "a long silent turn isn't cut",
  placed:
    "a call from the open turn is placed in it with its call id, also when repeated",
  closedTurn: "a call from a turn that ended is refused",
  pictures: "a picture's bytes are left out of the events",
} as const;

export type Case = keyof typeof CASES;

export interface Harness {
  /** A fresh adapter whose provider behaves as `script` says. */
  setUp: (script: Script) => Promise<Setup>;
  /**
   * The `_meta` the provider sends with call `call` it makes to Rufi's tools
   * from `turn` of `conversation`, having made the call as it would.
   */
  callMeta: (
    conversation: Conversation,
    turn: string,
    call: string,
  ) => Promise<unknown>;
  /** Cases this provider never gets into, with why: skipped. */
  cannot?: Partial<Record<Case, string>>;
  /** Cases the adapter doesn't meet yet, with the change that will: to do. */
  pending?: Partial<Record<Case, string>>;
}

/** How long a case may take: a provider process is slow to start on CI. */
const CASE_MS = 30_000;
/** How long Rufi waits for an event before the case fails. */
const UNTIL_MS = 15_000;
/** How long nothing more must happen. */
const SETTLE_MS = 200;

/** Any text with words in it, in an expected value. */
const someText = () => expect.stringMatching(/\S/) as string;

const input = (id: string, text = "What was Asha's last TSH?"): Input => ({
  id,
  parts: [text],
});

/** The events of one conversation, as they came. */
function recorder() {
  const events: ProviderEvent[] = [];
  return {
    events,
    onEvent: (event: ProviderEvent) => {
      events.push(event);
    },
    /** The first event that `pick` takes, once it has come. */
    async until<T>(pick: (event: ProviderEvent) => T | undefined): Promise<T> {
      const deadline = Date.now() + UNTIL_MS;
      for (;;) {
        for (const event of events) {
          const found = pick(event);
          if (found !== undefined) return found;
        }
        if (Date.now() > deadline) {
          throw new Error("The event didn't come.");
        }
        await sleep(10);
      }
    },
  };
}

const startedBy = (id: string) => (event: ProviderEvent) =>
  event.type === "turnStarted" && event.inputs.includes(id)
    ? event.turn
    : undefined;

const endOf = (turn: string) => (event: ProviderEvent) =>
  event.type === "turnEnded" && event.turn === turn ? event.end : undefined;

export function providerContract(name: string, harness: Harness): void {
  describe(`${name} meets the provider boundary`, () => {
    const setups: Setup[] = [];
    afterEach(async () => {
      for (const setup of setups.splice(0)) {
        await setup.adapter.close();
        await setup.close?.();
      }
    });

    /** A case's adapter, with one conversation's events and how to open it. */
    async function begin(script: Script = {}) {
      const setup = await harness.setUp(script);
      setups.push(setup);
      const recorded = recorder();
      const { model, effort } = setup.options;
      const open = (more: Partial<OpenOptions> = {}) =>
        setup.adapter.open({
          ...setup.options,
          instructions: "Answer briefly.",
          onEvent: recorded.onEvent,
          ...more,
        });
      /** Starts a turn with `id`; its reference, once it has started. */
      const start = async (conversation: Conversation, id: string) => {
        expect(
          await conversation.startTurn({ input: input(id), model, effort }),
        ).toEqual({ status: "delivered" });
        return recorded.until(startedBy(id));
      };
      return { ...setup, ...recorded, open, start };
    }

    function test(key: Case, body: () => Promise<void>): void {
      const cannot = harness.cannot?.[key];
      const pending = harness.pending?.[key];
      if (cannot) it.skip(`${CASES[key]} (never: ${cannot})`, body);
      else if (pending) it.todo(`${CASES[key]} (pending: ${pending})`);
      else it(CASES[key], body, CASE_MS);
    }

    test("models", async () => {
      const { adapter } = await begin();
      const models = await adapter.models();
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.efforts.length).toBeGreaterThan(0);
        if (model.defaultEffort !== undefined) {
          expect(model.efforts).toContain(model.defaultEffort);
        }
      }
    });

    test("resume", async () => {
      const run = await begin();
      const first = await run.open();
      const turn = await run.start(first, "message-1");
      await run.until(endOf(turn));
      await first.close();
      const again = await run.open({ resume: first.ref });
      expect(again.ref).toBe(first.ref);
      const next = await run.start(again, "message-2");
      expect(await run.until(endOf(next))).toEqual({
        status: "done",
        answer: ANSWER,
      });
    });

    test("missing", async () => {
      const run = await begin();
      await expect(
        run.open({ resume: "0b7e4c1a-5d2f-4e8b-9a6c-3f1d2e4b5a6c" }),
      ).rejects.toBeInstanceOf(Missing);
    });

    test("notOpened", async () => {
      const run = await begin({ resumeFails: true });
      const first = await run.open();
      await run.until(endOf(await run.start(first, "message-1")));
      await first.close();
      const error: unknown = await run
        .open({ resume: first.ref })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(NotOpened);
    });

    test("turn", async () => {
      const run = await begin();
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      const end = await run.until(endOf(turn));
      expect(end).toEqual({ status: "done", answer: ANSWER });
      const mine = run.events.filter((event) => event.turn === turn);
      expect(mine[0]).toEqual({
        type: "turnStarted",
        turn,
        inputs: ["message-1"],
      });
      expect(mine.at(-1)).toEqual({ type: "turnEnded", turn, end });
      expect(mine.filter((event) => event.type === "turnEnded")).toHaveLength(
        1,
      );
    });

    test("refused", async () => {
      const run = await begin({ start: "refuses" });
      const conversation = await run.open();
      expect(
        await conversation.startTurn({
          input: input("message-1"),
          model: run.options.model,
          effort: run.options.effort,
        }),
      ).toEqual({ status: "not_delivered", text: someText() });
      await sleep(SETTLE_MS);
      expect(
        run.events.filter((event) => event.type === "turnStarted"),
      ).toEqual([]);
    });

    test("signedOut", async () => {
      const run = await begin({ signedIn: false });
      // A provider may need its sign-in to open, or only to start a turn.
      const outcome = await run.open().then(
        (conversation) =>
          conversation.startTurn({
            input: input("message-1"),
            model: run.options.model,
            effort: run.options.effort,
          }),
        (error: unknown) => error,
      );
      if (outcome instanceof NotOpened) {
        expect(outcome.reason).toBe("signed_out");
      } else {
        expect(outcome).toEqual({
          status: "not_delivered",
          reason: "signed_out",
          text: someText(),
        });
      }
      await sleep(SETTLE_MS);
      expect(
        run.events.filter((event) => event.type === "turnStarted"),
      ).toEqual([]);
    });

    test("lostStart", async () => {
      const run = await begin({ start: "loses_reply" });
      const conversation = await run.open();
      expect(
        await conversation.startTurn({
          input: input("message-1"),
          model: run.options.model,
          effort: run.options.effort,
        }),
      ).toEqual({ status: "uncertain", text: someText() });
      const received = await conversation.reconcile([
        "message-1",
        "never-sent",
      ]);
      expect(received.get("message-1")).toBe("received");
      expect(received.get("never-sent")).not.toBe("received");
    });

    test("steer", async () => {
      const run = await begin({ turn: "runs" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      expect(
        await conversation.steer({
          input: input("steer-1", "And the date?"),
          turn,
        }),
      ).toEqual({ status: "delivered" });
    });

    test("lateSteer", async () => {
      const run = await begin();
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      await run.until(endOf(turn));
      expect(
        await conversation.steer({
          input: input("steer-1", "And the date?"),
          turn,
        }),
      ).toEqual({ status: "not_delivered", text: someText() });
      await sleep(SETTLE_MS);
      expect(
        run.events.filter((event) => event.type === "turnStarted"),
      ).toHaveLength(1);
    });

    test("lostSteer", async () => {
      const run = await begin({ turn: "runs", steer: "loses_reply" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      expect(
        await conversation.steer({
          input: input("steer-1", "And the date?"),
          turn,
        }),
      ).toEqual({ status: "uncertain", text: someText() });
      const received = await conversation.reconcile(["steer-1"]);
      expect(received.get("steer-1")).toBe("received");
    });

    test("nextTurn", async () => {
      const run = await begin({ turn: "runs", steer: "starts_next" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      const outcome = await conversation.steer({
        input: input("steer-1", "And the date?"),
        turn,
      });
      const before = run.events.slice();
      expect(outcome).toEqual({
        status: "next_turn",
        turn: someText(),
      });
      const next = outcome.status === "next_turn" ? outcome.turn : "";
      expect(next).not.toBe(turn);
      expect(before).toContainEqual({
        type: "turnStarted",
        turn: next,
        inputs: ["steer-1"],
      });
      expect(before.findIndex(endOf(turn))).toBeLessThan(
        before.findIndex(startedBy("steer-1")),
      );
    });

    test("heldSteer", async () => {
      const run = await begin({ turn: "runs", steer: "holds" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      const outcome = conversation.steer({
        input: input("steer-1", "And the date?"),
        turn,
      });
      await sleep(SETTLE_MS);
      await conversation.stop(turn);
      expect(await outcome).toEqual({
        status: "not_delivered",
        text: someText(),
      });
      expect(await run.until(endOf(turn))).toEqual({ status: "stopped" });
    });

    test("stop", async () => {
      const run = await begin({ turn: "runs" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      await conversation.stop(turn);
      expect(run.events.at(-1)).toEqual({
        type: "turnEnded",
        turn,
        end: { status: "stopped" },
      });
      const seen = run.events.length;
      // Once more, as when the turn ends just as Stop is pressed.
      await conversation.stop(turn);
      await sleep(SETTLE_MS);
      expect(run.events).toHaveLength(seen);
    });

    test("stuck", async () => {
      const run = await begin({ turn: "runs", ignoresInterrupt: true });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      await conversation.stop(turn);
      expect(await run.until(endOf(turn))).toEqual({ status: "stopped" });
    });

    test("fails", async () => {
      const run = await begin({ turn: "fails" });
      const conversation = await run.open();
      const end = await run.until(
        endOf(await run.start(conversation, "message-1")),
      );
      expect(end).toEqual({
        status: "failed",
        reason: "other",
        text: someText(),
      });
    });

    test("usageLimit", async () => {
      const run = await begin({ turn: "usage_limit" });
      const conversation = await run.open();
      const end = await run.until(
        endOf(await run.start(conversation, "message-1")),
      );
      expect(end).toMatchObject({ status: "failed", reason: "usage_limit" });
      const resetsAt = (end as Extract<TurnEnd, { status: "failed" }>).resetsAt;
      expect(Number.isNaN(Date.parse(resetsAt ?? ""))).toBe(false);
    });

    test("dies", async () => {
      const run = await begin({ turn: "dies" });
      const conversation = await run.open();
      const end = await run.until(
        endOf(await run.start(conversation, "message-1")),
      );
      expect(end).toMatchObject({ status: "failed", reason: "process_died" });
    });

    test("renews", async () => {
      const run = await begin({ turn: "renews" });
      const conversation = await run.open();
      expect(
        await run.until(endOf(await run.start(conversation, "message-1"))),
      ).toEqual({ status: "done", answer: ANSWER });
    });

    test("renewalFails", async () => {
      const run = await begin({ turn: "renewal_fails" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      expect(await run.until(endOf(turn))).toMatchObject({
        status: "failed",
        reason: "signed_out",
      });
      await sleep(SETTLE_MS);
      expect(
        run.events.filter((event) => event.type === "turnStarted"),
      ).toHaveLength(1);
      expect(
        (await conversation.reconcile(["message-1"])).get("message-1"),
      ).toBe("received");
    });

    test("noLimit", async () => {
      const run = await begin({ turn: "silent" });
      const conversation = await run.open();
      expect(
        await run.until(endOf(await run.start(conversation, "message-1"))),
      ).toEqual({ status: "done", answer: ANSWER });
    });

    test("placed", async () => {
      const run = await begin({ turn: "runs" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      const meta = await harness.callMeta(conversation, turn, "call-1");
      expect(conversation.placeCall(meta)).toEqual({ turn, call: "call-1" });
      expect(conversation.placeCall(meta)).toEqual({ turn, call: "call-1" });
      expect(conversation.placeCall({})).toBeUndefined();
      expect(conversation.placeCall(undefined)).toBeUndefined();
    });

    test("closedTurn", async () => {
      const run = await begin({ turn: "runs" });
      const conversation = await run.open();
      const turn = await run.start(conversation, "message-1");
      const meta = await harness.callMeta(conversation, turn, "call-1");
      await conversation.stop(turn);
      expect(conversation.placeCall(meta)).toBeUndefined();
    });

    test("pictures", async () => {
      const picture = Buffer.from("a fictional page image").toString("base64");
      const run = await begin({ picture });
      const conversation = await run.open();
      await run.until(endOf(await run.start(conversation, "message-1")));
      expect(run.events.some((event) => event.type === "step")).toBe(true);
      expect(JSON.stringify(run.events)).not.toContain(picture);
    });
  });
}
