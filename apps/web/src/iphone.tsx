// Settings → iPhone (docs/help/iphone.md): the apps paired with this Rufi,
// each for one person's record, with Unpair; and Pair an iPhone, which sets
// up Tailscale and shows a code, as a QR code and a link, that works once
// for 10 minutes. Phones are for your own record only for now.
import { Dialog } from "@base-ui/react/dialog";
import { PairedApps, type PairedApp } from "@rufi/contracts/remote";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Plus, Unlink, X } from "lucide-react";
import { toDataURL } from "qrcode";
import { useEffect, useId, useState } from "react";
import { read } from "./api.ts";
import { printedDay, printedTime } from "./dates.ts";
import { queries, usePairedApps, usePeople } from "./reads.ts";
import { Button, Problem, Section } from "./ui.tsx";

const PANEL =
  "fixed top-1/2 left-1/2 z-50 flex w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[14px] bg-surface p-[18px] shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-50 bg-ink/25";

const OWN_RECORD =
  "Pair a phone for your own record only for now: Rufi AI on the phone can read every person's files in this folder.";

const shown = (state: PairedApps) => {
  queries.setQueryData(["paired-apps"], state);
};

export function IPhoneSection() {
  const paired = usePairedApps();
  const people = usePeople().data ?? [];
  // More than one person: whose record, chosen before pairing.
  const [asking, setAsking] = useState(false);
  const [whose, setWhose] = useState<string>();
  // The apps paired when the code was made: a new one is the phone that used it.
  const [before, setBefore] = useState<readonly string[]>();
  const start = useMutation({
    mutationFn: (personId: string) =>
      read(PairedApps, "POST", "/api/paired-apps/pairing", { personId }),
    onSuccess: (state) => {
      setBefore(paired.data?.apps.map(({ id }) => id) ?? []);
      setAsking(false);
      setWhose(undefined);
      shown(state);
    },
  });
  const close = useMutation({
    mutationFn: () =>
      read(PairedApps, "POST", "/api/paired-apps/pairing/cancel"),
    onSettled: (state) => {
      setBefore(undefined);
      if (state) shown(state);
    },
  });
  const whoseId = useId();
  if (paired.error) {
    return (
      <Section title="Paired iPhones">
        <Problem error={paired.error} retry={() => void paired.refetch()} />
      </Section>
    );
  }
  const state = paired.data;
  if (!state) return null;
  const pair = () => {
    const only = people.length === 1 ? people[0] : undefined;
    if (only) start.mutate(only.id);
    else setAsking(true);
  };
  return (
    <Section title="Paired iPhones">
      <div className="flex flex-col gap-3">
        {state.trouble !== null && (
          <p role="alert" className="text-accent-ink">
            {state.trouble}
          </p>
        )}
        {state.apps.length > 0 && (
          <ul className="flex flex-col gap-2">
            {state.apps.map((app) => (
              <AppLine key={app.id} app={app} />
            ))}
          </ul>
        )}
        {asking ? (
          <fieldset className="flex flex-col gap-2 rounded-lg border border-line bg-page p-3">
            <legend id={whoseId} className="font-medium">
              Whose record does this iPhone open?
            </legend>
            <div role="radiogroup" aria-labelledby={whoseId}>
              {people.map((person) => (
                <label key={person.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="whose-iphone"
                    checked={whose === person.id}
                    onChange={() => {
                      setWhose(person.id);
                    }}
                  />
                  {person.displayName}
                </label>
              ))}
            </div>
            <p className="text-muted">{OWN_RECORD}</p>
            <div className="flex gap-2">
              <Button
                icon={X}
                disabled={start.isPending}
                onClick={() => {
                  setAsking(false);
                  setWhose(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                look="main"
                icon={Plus}
                disabled={whose === undefined}
                busy={start.isPending && "Setting up Tailscale…"}
                onClick={() => {
                  if (whose !== undefined) start.mutate(whose);
                }}
              >
                Pair
              </Button>
            </div>
          </fieldset>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Button
              icon={Plus}
              busy={start.isPending && "Setting up Tailscale…"}
              onClick={pair}
            >
              Pair an iPhone
            </Button>
            <p className="text-muted">
              Through Tailscale, on this Mac and the iPhone.
            </p>
          </div>
        )}
        {start.error && (
          <p role="alert" className="text-muted">
            {start.error.message}
          </p>
        )}
      </div>
      {before !== undefined && (
        <PairingDialog
          state={state}
          before={before}
          closing={close.isPending}
          close={() => {
            close.mutate();
          }}
        />
      )}
    </Section>
  );
}

/** One paired app: whose, when, and Unpair, which asks first. */
function AppLine({ app }: { app: PairedApp }) {
  const [asked, setAsked] = useState(false);
  const unpair = useMutation({
    mutationFn: () =>
      read(
        PairedApps,
        "POST",
        `/api/paired-apps/${encodeURIComponent(app.id)}/unpair`,
      ),
    onSuccess: (state) => {
      setAsked(false);
      shown(state);
    },
  });
  return (
    <li className="flex items-center gap-3">
      <div className="flex grow flex-col gap-0.5">
        <p>
          {app.name} · for {app.person.name}
        </p>
        <p className="text-muted">
          Paired {printedDay(app.pairedAt)}
          {app.lastSeenAt !== null &&
            ` · Last seen ${printedTime(app.lastSeenAt)}`}
        </p>
      </div>
      <Button
        look="quiet"
        icon={Unlink}
        onClick={() => {
          setAsked(true);
        }}
      >
        Unpair
      </Button>
      {asked && (
        <Dialog.Root
          open
          onOpenChange={(next) => {
            if (!next) setAsked(false);
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop className={BACKDROP} />
            <Dialog.Popup className={PANEL}>
              <Dialog.Title className="text-[0.9375rem] font-semibold">
                Unpair {app.name}?
              </Dialog.Title>
              <Dialog.Description>
                It can't open Rufi any more, from now. What it sent stays.
              </Dialog.Description>
              {unpair.error && (
                <p role="alert" className="text-muted">
                  {unpair.error.message}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Dialog.Close render={<Button icon={X}>Cancel</Button>} />
                <Button
                  look="main"
                  icon={Unlink}
                  busy={unpair.isPending && "Unpairing…"}
                  onClick={() => {
                    unpair.mutate();
                  }}
                >
                  Unpair
                </Button>
              </div>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </li>
  );
}

/**
 * The code, as a QR code and a link, until a phone uses it; then who it
 * paired. Closing it ends the code.
 */
function PairingDialog({
  state,
  before,
  closing,
  close,
}: {
  state: PairedApps;
  before: readonly string[];
  closing: boolean;
  close: () => void;
}) {
  const { pairing } = state;
  const added = state.apps.find(({ id }) => !before.includes(id));
  // Kept once known: the code is gone when a phone used it.
  const [person, setPerson] = useState(pairing?.person.name);
  const [picture, setPicture] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const link = pairing?.link;
  useEffect(() => {
    if (link === undefined) return;
    let current = true;
    void toDataURL(link, { margin: 1, width: 440 }).then((url) => {
      if (current) setPicture(url);
    });
    return () => {
      current = false;
    };
  }, [link]);
  useEffect(() => {
    if (pairing) setPerson(pairing.person.name);
  }, [pairing]);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup className={PANEL}>
          <Dialog.Title className="text-[0.9375rem] font-semibold">
            Pair an iPhone{person === undefined ? "" : ` for ${person}`}
          </Dialog.Title>
          {added ? (
            <Dialog.Description role="status">
              Paired: {added.name}, for {added.person.name}
            </Dialog.Description>
          ) : pairing ? (
            <>
              {picture !== undefined && (
                <img
                  src={picture}
                  alt="The pairing code, to scan with Rufi on your iPhone"
                  className="size-[220px] self-center"
                />
              )}
              <Dialog.Description>
                Scan this with Rufi on your iPhone, or paste the link there. It
                works once, for 10 minutes.
              </Dialog.Description>
              <p className="text-muted">{OWN_RECORD}</p>
            </>
          ) : (
            <Dialog.Description role="alert">
              This code has expired. Make a new one with Pair an iPhone.
            </Dialog.Description>
          )}
          <div className="flex items-center justify-end gap-2">
            {copied !== undefined && !added && (
              <span role="status" className="text-xs text-muted">
                {copied}
              </span>
            )}
            {pairing && !added && (
              <Button
                icon={Copy}
                onClick={() => {
                  navigator.clipboard.writeText(pairing.link).then(
                    () => {
                      setCopied("Copied");
                    },
                    () => {
                      setCopied("Couldn't copy");
                    },
                  );
                }}
              >
                Copy link
              </Button>
            )}
            <Button
              look={added ? "main" : "plain"}
              icon={added ? Check : X}
              busy={closing && "Closing…"}
              onClick={close}
            >
              {added ? "Done" : "Close"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
