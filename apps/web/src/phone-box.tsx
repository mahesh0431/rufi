// The chat's box in the iPhone app: the app draws its own (SwiftUI), and
// the page keeps the box's rules: the draft and its saves, the send, the
// chips, Ask Rufi, Stop, the model and effort (box.tsx). Here the page
// tells the app the box as it is (`box`), and does what the app's box asks
// (`window.rufi.box`). The page draws no box of its own then (chat.tsx).
import {
  CLAUDE_SIGNED_OUT,
  DEFAULT_EFFORT,
  SIGNED_OUT,
  EFFORTS,
  MODELS,
  modelOf,
  type Effort,
  type Person,
  type Provider,
} from "@rufi/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { useAttachNotice } from "./attach.tsx";
import { useBoxLogic } from "./box.tsx";
import { CONTEXT_WORDS, contextUsed } from "./context-meter.tsx";
import { chipKey } from "./draft.ts";
import type { Live } from "./live.ts";
import {
  chooseEffort,
  chooseModel,
  EFFORT_NAMES,
  EFFORT_WORDS,
  effortName,
  SIGN_IN,
} from "./model-menu.tsx";
import { openPanel, usePanel, whyClosed } from "./panel.ts";
import { type BoxView, onBox, tell } from "./phone.ts";
import { useStatus } from "./reads.ts";

export function PhoneBox({
  person,
  live,
}: {
  person: Person;
  live: StoreApi<Live>;
}) {
  const logic = useBoxLogic(person, live);
  const { box, text, chips, working, hasText, locked, enter } = logic;
  const loaded = logic.loaded;
  const closed = useStore(box.store, whyClosed);
  const attachNotice = useAttachNotice(person.id);
  const asked = usePanel((state) => state.asked);
  const panel = usePanel((state) => state.open);
  const status = useStatus().data;
  const chosen = useStore(live, (state) => state.chat);
  const context = useStore(live, (state) => state.chat?.context ?? null);
  /** The text the app has: what it typed, or what the page last told it. */
  const known = useRef("");
  /** The latest acts, for the app's asks. */
  const acts = useRef(logic);
  useLayoutEffect(() => {
    acts.current = logic;
  });

  const out = (provider: Provider) =>
    status !== undefined && status[provider].state !== "signed_in";
  const model = chosen?.model ?? MODELS[0].id;
  const effort = chosen?.effort ?? DEFAULT_EFFORT;
  const why = logic.why;
  // On a phone, sign-in is on the Mac.
  const line =
    why === SIGNED_OUT || why === CLAUDE_SIGNED_OUT
      ? `${why} Sign in on your Mac.`
      : (why ?? attachNotice ?? logic.saved);

  const view: BoxView = {
    placeholder: logic.placeholder,
    chips: chips.map((chip) => ({
      key: chipKey(chip),
      label: chip.label,
      kind:
        chip.pointer.type === "document" || chip.pointer.type === "record"
          ? chip.pointer.type
          : "other",
    })),
    ready: loaded && !locked,
    button: working ? (hasText && !locked ? enter : "stop") : "send",
    canSend: working ? true : hasText && !locked,
    model: { id: model, name: modelOf(model)?.name ?? model },
    effort: { id: effort, name: effortName(effort) },
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      available: !out(m.provider),
    })),
    signIn: [...new Set(MODELS.map((m) => m.provider))]
      .filter(out)
      .map((provider) => `${SIGN_IN[provider]} on your Mac`),
    efforts: EFFORTS.map((e) => ({ id: e, name: EFFORT_NAMES[e] })),
    effortWords: EFFORT_WORDS,
    meter:
      context === null
        ? null
        : { used: contextUsed(context), words: CONTEXT_WORDS },
    line,
    retry: line === "Not saved",
    closed,
    asked,
    panel,
  };
  const said = JSON.stringify(view);
  useEffect(() => {
    const message = { type: "box" as const, ...(JSON.parse(said) as BoxView) };
    // Only the text the page changed goes to the app.
    if (text !== known.current) {
      known.current = text;
      message.text = text;
    }
    tell(message);
  }, [said, text]);

  // What the app's box asks.
  useEffect(
    () =>
      onBox((command) => {
        const now = acts.current;
        switch (command.type) {
          case "text":
            known.current = command.text;
            now.box.type(command.text);
            if (usePanel.getState().refused !== null) {
              usePanel.setState({ refused: null });
            }
            break;
          case "send":
            if (now.hasText && !now.locked) now.submit(now.enter);
            break;
          case "stop":
            void now.stop();
            break;
          case "remove": {
            const chip = now.chips.find((c) => chipKey(c) === command.key);
            if (chip !== undefined && !now.locked) void now.remove(chip);
            break;
          }
          case "model":
            void now.act(() => chooseModel(person.id, command.id));
            break;
          case "effort":
            void now.act(() => chooseEffort(person.id, command.id as Effort));
            break;
          case "retry":
            void now.box.saveNow();
            break;
          case "open":
            openPanel();
            break;
          case "close":
            usePanel.setState({ open: false, focusBefore: null });
            break;
        }
      }),
    [person.id],
  );
  return null;
}
