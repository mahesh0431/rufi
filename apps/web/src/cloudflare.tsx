// Settings › iPhone, with Cloudflare Tunnel chosen (docs/help/iphone.md):
// installing cloudflared, setting Cloudflare up with an address and an API
// token made on Cloudflare's own form, and the address once set up. Rufi
// uses the token for the setup only and doesn't keep it.
import { PairedApps } from "@rufi/contracts/remote";
import { Cloud, Copy, ExternalLink, Pencil, X } from "lucide-react";
import { useId, useState } from "react";
import { read } from "./api.ts";
import { queries } from "./reads.ts";
import { Button, buttonLook, ICON } from "./ui.tsx";

/**
 * How long setting up may take: Rufi's deadline for its calls to
 * Cloudflare (60 s), with room for the answer.
 */
const SETUP_MS = 70_000;

/**
 * Cloudflare's form for an account API token, filled in: Cloudflare
 * Tunnel: Edit (by its permission group's id, which has no short key),
 * Zone: Read and DNS: Edit.
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 */
const TOKEN_FORM = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    // A public id of Cloudflare's, not a secret.
    { key: "c07321b023e944ff818fec44d8203567", type: "edit" }, // gitleaks:allow
    { key: "zone", type: "read" },
    { key: "dns", type: "edit" },
  ]),
)}&name=Rufi`;

const INSTALL = "brew install cloudflared";

const FIELD = "rounded-lg border border-line bg-surface px-3 py-2";

export function CloudflareSetup({
  state,
  locked,
}: {
  state: PairedApps;
  /** An iPhone is paired or a code is live: nothing here can change. */
  locked: boolean;
}) {
  const { installed, address } = state.route.cloudflare;
  const [changing, setChanging] = useState(false);
  const [typed, setTyped] = useState<string>();
  const [token, setToken] = useState("");
  const [justSetUp, setJustSetUp] = useState(false);
  const [copied, setCopied] = useState<string>();
  const addressId = useId();
  const tokenId = useId();
  // Not a mutation: TanStack keeps a mutation's variables after it ends,
  // and the token must go when the call does.
  const [settingUp, setSettingUp] = useState(false);
  // Only its words: an Error keeps the functions on its stack, and so the
  // token they saw.
  const [problem, setProblem] = useState<string>();
  const setUp = async () => {
    const sent = { address: typed ?? "", token };
    setToken("");
    setSettingUp(true);
    setProblem(undefined);
    try {
      queries.setQueryData(
        ["paired-apps"],
        await read(
          PairedApps,
          "POST",
          "/api/remote/cloudflare/setup",
          sent,
          SETUP_MS,
        ),
      );
      setChanging(false);
      setTyped(undefined);
      setJustSetUp(true);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSettingUp(false);
    }
  };

  if (!installed) {
    return (
      <div className="flex flex-col gap-1.5">
        <p>Install cloudflared on this Mac:</p>
        <div className="flex items-center gap-2">
          <code className="rounded-md bg-side px-2 py-1 font-mono">
            {INSTALL}
          </code>
          <Button
            icon={Copy}
            onClick={() => {
              navigator.clipboard.writeText(INSTALL).then(
                () => {
                  setCopied("Copied");
                },
                () => {
                  setCopied("Couldn't copy");
                },
              );
            }}
          >
            Copy
          </Button>
          {copied !== undefined && (
            <span role="status" className="text-xs text-muted">
              {copied}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (address !== null && !changing) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <p className="font-medium">{address}</p>
          {!locked && (
            <Button
              look="quiet"
              icon={Pencil}
              onClick={() => {
                setChanging(true);
                setTyped(address);
                setJustSetUp(false);
              }}
            >
              Change
            </Button>
          )}
        </div>
        {justSetUp && (
          <p className="text-muted">
            You can delete the token in Cloudflare now.
          </p>
        )}
      </div>
    );
  }

  const busy = settingUp || locked;
  const value = typed ?? "";
  return (
    <form
      className="flex max-w-[420px] flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void setUp();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={addressId} className="font-medium">
          Address
        </label>
        <input
          id={addressId}
          value={value}
          placeholder="rufi.example.com"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <a
          href={TOKEN_FORM}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonLook({ look: "plain" })}
        >
          <ExternalLink size={ICON} aria-hidden />
          Create token
        </a>
        <p className="text-muted">
          Copy the token Cloudflare shows, then paste it here.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={tokenId} className="font-medium">
          Token
        </label>
        <input
          id={tokenId}
          type="password"
          value={token}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => {
            setToken(event.target.value);
          }}
          className={FIELD}
        />
      </div>
      {problem && (
        <p role="alert" className="text-muted">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        {changing && (
          <Button
            icon={X}
            disabled={settingUp}
            onClick={() => {
              setChanging(false);
              setTyped(undefined);
              setToken("");
              setProblem(undefined);
            }}
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          look="main"
          icon={Cloud}
          disabled={busy || value.trim() === "" || token === ""}
          busy={settingUp && "Setting up Cloudflare…"}
        >
          Set up
        </Button>
      </div>
    </form>
  );
}
