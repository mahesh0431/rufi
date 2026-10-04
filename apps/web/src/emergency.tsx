// The Emergency sheet: the local number and what to do now. It needs nothing
// but the settings already read (or none): no AI, no sign-in, no person.
import { useNavigate } from "@tanstack/react-router";
import { Phone } from "lucide-react";
import { useRef } from "react";
import { useSettings } from "./reads.ts";
import { Button } from "./ui.tsx";

export function Emergency() {
  const sheet = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  // When the settings can't be read, the sheet works as if no region is set.
  const known = useSettings().data?.emergency ?? null;
  const toSettings = () => {
    sheet.current?.close();
    void navigate({ to: "/settings" });
  };
  // Without a region the heading already says to call.
  const first = known
    ? `Call ${known.number} now. Say who needs help, where you are and what happened.`
    : "When you call, say who needs help, where you are and what happened.";

  return (
    <>
      <Button onClick={() => sheet.current?.showModal()}>
        <Phone size={14} aria-hidden />
        Emergency
      </Button>
      <dialog
        ref={sheet}
        aria-labelledby="emergency-title"
        className="mx-auto mt-12 w-[560px] max-w-[calc(100%-32px)] rounded-2xl border border-line bg-white p-6 text-ink shadow-xl"
      >
        <p className="text-muted">Works without the AI</p>
        {known ? (
          <div className="mt-1.5 mb-1 flex flex-wrap items-baseline gap-3.5">
            <h2 id="emergency-title" className="text-5xl font-bold">
              {known.number}
            </h2>
            <span className="text-muted">
              Emergency number · {known.name} ·{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={toSettings}
              >
                change in Settings
              </button>
            </span>
          </div>
        ) : (
          <h2 id="emergency-title" className="mt-1.5 mb-1 text-2xl font-bold">
            Call your local emergency number now.
          </h2>
        )}
        <ol className="mt-3 list-decimal space-y-1 pl-5">
          <li>{first}</li>
          <li>
            If the person is unconscious, check they are breathing and follow
            the call handler's instructions.
          </li>
          <li>Don't wait for Rufi or any AI to answer.</li>
        </ol>
        <div className="mt-5 flex justify-end gap-2">
          {!known && <Button onClick={toSettings}>Choose your region</Button>}
          <Button look="quiet" autoFocus onClick={() => sheet.current?.close()}>
            Close
          </Button>
        </div>
      </dialog>
    </>
  );
}
