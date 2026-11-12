// Settings → iPhone (docs/help/iphone.md): how the iPhone reaches this Mac
// (Tailscale, Tailscale Funnel or Cloudflare Tunnel, set up here too),
// changed only while nothing is paired;
// the apps paired with this Rufi, each for one person's record, with
// Unpair; and Pair an iPhone, which sets up the route and shows a code, as
// a QR code and a link, that works once for 10 minutes. Phones are for your
// own record only for now.
import { Dialog } from "@base-ui/react/dialog";
import {
  PairedApps,
  type PairedApp,
  type Pairing,
  type RouteKind,
} from "@rufi/contracts/remote";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Plus, Unlink, X } from "lucide-react";
import { toDataURL } from "qrcode";
import { useEffect, useId, useState } from "react";
import { read } from "./api.ts";
import { CloudflareSetup } from "./cloudflare.tsx";
import { printedDay, printedTime } from "./dates.ts";
import { PUBLIC_LINE } from "./public-line.ts";
import { queries, usePairedApps, usePeople } from "./reads.ts";
import { Button, Problem, Section } from "./ui.tsx";

const PANEL =
  "fixed top-1/2 left-1/2 z-50 flex w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[14px] bg-surface p-[18px] shadow-menu outline-none";
const BACKDROP = "fixed inset-0 z-50 bg-ink/25";

/**
 * How long Pair an iPhone may take: the route's commands, the check through
 * it (30 s, for the first certificate), and the clean-up after a failure.
 */
const PAIRING_MS = 60_000;

const OWN_RECORD =
  "Pair a phone for your own record only for now: Rufi AI on the phone can read every person's files in this folder.";

/** Each route: its name, its line under the choice, and the hint under Pair. */
const ROUTES: readonly {
  kind: RouteKind;
  label: string;
  line: string;
  hint: string;
}[] = [
  {
    kind: "tailscale",
    label: "Tailscale",
    line: "Your tailnet only.",
    hint: "Through Tailscale, on this Mac and the iPhone.",
  },
  {
    kind: "funnel",
    label: "Tailscale Funnel",
    line: PUBLIC_LINE.funnel,
    hint: "Through Tailscale Funnel; the iPhone needs no VPN.",
  },
  {
    kind: "cloudflare",
    label: "Cloudflare Tunnel",
    line: PUBLIC_LINE.cloudflare,
    hint: "Through Cloudflare Tunnel; the iPhone needs no VPN.",
  },
];

const shown = (state: PairedApps) => {
  queries.setQueryData(["paired-apps"], state);
};

export function IPhoneSection() {
  const paired = usePairedApps();
  const people = usePeople().data ?? [];
  // More than one person: whose record, chosen before pairing.
  const [asking, setAsking] = useState(false);
  const [whose, setWhose] = useState<string>();
  // The code this window made, and the apps paired then: a new one for its
  // person is the phone that used it.
  const [made, setMade] = useState<{
    code: Pairing;
    before: readonly string[];
  }>();
  const start = useMutation({
    // Rufi sets up the route first, and checks it can reach itself through
    // it: that can take most of a minute the first time.
    mutationFn: (personId: string) =>
      read(
        PairedApps,
        "POST",
        "/api/paired-apps/pairing",
        { personId },
        PAIRING_MS,
      ),
    onSuccess: (state) => {
      if (state.pairing) {
        setMade({
          code: state.pairing,
          before: paired.data?.apps.map(({ id }) => id) ?? [],
        });
      }
      setAsking(false);
      setWhose(undefined);
      shown(state);
    },
  });
  // Only this window's code ends: another window may have made a newer one.
  const close = useMutation({
    mutationFn: async (live: boolean) =>
      live
        ? read(PairedApps, "POST", "/api/paired-apps/pairing/cancel")
        : undefined,
    onSettled: (state) => {
      setMade(undefined);
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
  const route = ROUTES.find(({ kind }) => kind === state.route.kind);
  // Cloudflare pairs only once it is set up.
  const ready =
    state.route.kind !== "cloudflare" ||
    state.route.cloudflare.address !== null;
  return (
    <>
      <RouteChoice state={state} />
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
                  busy={start.isPending && "Connecting…"}
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
                disabled={!ready}
                busy={start.isPending && "Connecting…"}
                onClick={pair}
              >
                Pair an iPhone
              </Button>
              {!ready ? (
                <p className="text-muted">Set up Cloudflare first.</p>
              ) : (
                route && <p className="text-muted">{route.hint}</p>
              )}
            </div>
          )}
          {start.error && (
            <p role="alert" className="text-muted">
              {start.error.message}
            </p>
          )}
        </div>
        {made !== undefined && (
          <PairingDialog
            state={state}
            code={made.code}
            before={made.before}
            closing={close.isPending}
            close={(live) => {
              close.mutate(live);
            }}
          />
        )}
      </Section>
    </>
  );
}

/**
 * How the iPhone reaches this Mac: one route at a time, chosen only while
 * no iPhone is paired and no code is live, since a paired iPhone keeps the
 * address it paired at. A public route says so once, under it.
 */
function RouteChoice({ state }: { state: PairedApps }) {
  const heading = useId();
  const busy = state.apps.length > 0 || state.pairing !== null;
  // What was just chosen, shown until the core has it.
  const [picked, setPicked] = useState<RouteKind>();
  const choose = useMutation({
    scope: { id: "route" },
    mutationFn: (kind: RouteKind) =>
      read(PairedApps, "PUT", "/api/remote/route", { kind }),
    onSuccess: shown,
    onSettled: () => {
      setPicked(undefined);
    },
  });
  const chosen = picked ?? state.route.kind;
  const line = ROUTES.find(({ kind }) => kind === chosen)?.line ?? "";
  return (
    <Section title="How your iPhone reaches this Mac" id={heading}>
      <div
        role="radiogroup"
        aria-labelledby={heading}
        aria-disabled={busy}
        className="inline-flex self-start rounded-lg border border-line bg-side p-0.5"
      >
        {ROUTES.map((route) => (
          <label
            key={route.kind}
            className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-disabled:opacity-60 has-focus-visible:outline-2 has-focus-visible:outline-accent"
          >
            <input
              type="radio"
              name="iphone-route"
              value={route.kind}
              checked={chosen === route.kind}
              disabled={busy}
              onChange={() => {
                setPicked(route.kind);
                choose.mutate(route.kind);
              }}
              // Over the whole segment, unseen: the segment is the radio.
              className="absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-default"
            />
            {route.label}
          </label>
        ))}
      </div>
      {line !== "" && <p className="text-muted">{line}</p>}
      {picked === undefined && state.route.kind === "cloudflare" && (
        <CloudflareSetup state={state} locked={busy} />
      )}
      {busy && (
        <p className="text-muted">Unpair your iPhones to change this.</p>
      )}
      {choose.error && (
        <p role="alert" className="text-muted">
          {choose.error.message}
        </p>
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
 * This window's code, as a QR code and a link, until a phone uses it; then
 * who it paired. A code replaced from another window, or expired, isn't
 * shown: the dialog never shows a code for anyone but the person it names.
 * Closing it ends the code.
 */
function PairingDialog({
  state,
  code,
  before,
  closing,
  close,
}: {
  state: PairedApps;
  code: Pairing;
  before: readonly string[];
  closing: boolean;
  close: (live: boolean) => void;
}) {
  const live = state.pairing?.link === code.link;
  const added = live
    ? undefined
    : state.apps.find(
        ({ id, person }) =>
          !before.includes(id) && person.id === code.person.id,
      );
  const [picture, setPicture] = useState<string>();
  const [copied, setCopied] = useState<string>();
  useEffect(() => {
    let current = true;
    void toDataURL(code.link, { margin: 1, width: 440 }).then((url) => {
      if (current) setPicture(url);
    });
    return () => {
      current = false;
    };
  }, [code.link]);
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) close(live);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={BACKDROP} />
        <Dialog.Popup className={PANEL}>
          <Dialog.Title className="text-[0.9375rem] font-semibold">
            Pair an iPhone for {code.person.name}
          </Dialog.Title>
          {added ? (
            <Dialog.Description role="status">
              Paired: {added.name}, for {added.person.name}
            </Dialog.Description>
          ) : live ? (
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
              This code has expired or was replaced by a newer one. Make a new
              one with Pair an iPhone.
            </Dialog.Description>
          )}
          <div className="flex items-center justify-end gap-2">
            {copied !== undefined && live && (
              <span role="status" className="text-xs text-muted">
                {copied}
              </span>
            )}
            {live && (
              <Button
                icon={Copy}
                onClick={() => {
                  navigator.clipboard.writeText(code.link).then(
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
              onClick={() => {
                close(live);
              }}
            >
              {added ? "Done" : "Close"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
