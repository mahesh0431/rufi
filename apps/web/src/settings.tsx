// Settings: the ChatGPT plan the AI uses, how Rufi looks, the region whose
// emergency number the AI gives, the model and effort documents are read
// with, backups, and the export of your data.
import { Backups } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DatabaseBackup, Download } from "lucide-react";
import { download, read } from "./api.ts";
import { AppearanceChoice } from "./appearance.tsx";
import { printedTime } from "./dates.ts";
import { EFFORTS } from "./model-menu.tsx";
import {
  queries,
  saveSettings,
  useBackups,
  useSettings,
  useStatus,
} from "./reads.ts";
import { Button, Problem } from "./ui.tsx";

export function SettingsPage() {
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (emergencyRegion: string | null) =>
      saveSettings({ emergencyRegion }),
  });

  return (
    <div className="mx-auto max-w-[620px] px-6 py-8">
      <PlanSection />
      <h2 id="appearance" className="mt-8 mb-2 px-0.5 font-semibold">
        Appearance
      </h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <AppearanceChoice labelledBy="appearance" />
        <p className="text-muted">
          System follows your Mac's light or dark appearance.
        </p>
      </div>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">Emergency</h2>
      <div className="rounded-xl border border-line bg-surface p-4">
        {settings.data === undefined && settings.error ? (
          <Problem
            error={settings.error}
            retry={() => void settings.refetch()}
          />
        ) : (
          settings.data && (
            <div className="flex flex-col gap-2">
              <label htmlFor="region" className="font-medium">
                Emergency region
              </label>
              <select
                id="region"
                value={settings.data.emergencyRegion ?? ""}
                disabled={save.isPending}
                onChange={(event) => {
                  save.mutate(event.target.value || null);
                }}
                className="w-64 rounded-lg border border-line bg-surface px-2 py-1.5"
              >
                <option value="">Not set</option>
                {settings.data.regions.map((region) => (
                  <option key={region.region} value={region.region}>
                    {region.name} ({region.number})
                  </option>
                ))}
              </select>
              <p className="text-muted">
                The AI gives this number when a message may describe an
                emergency. Not set: it says to call your local emergency number.
              </p>
              {save.error && (
                <p role="alert" className="text-muted">
                  {save.error.message}
                </p>
              )}
            </div>
          )
        )}
      </div>
      <DocumentsSection />
      <BackupsSection />
      <ExportSection />
    </div>
  );
}

/** The ChatGPT plan Rufi's AI runs on, or the way to sign in. */
function PlanSection() {
  const status = useStatus();
  const account = status.data?.account;
  return (
    <>
      <h2 className="mb-2 px-0.5 font-semibold">ChatGPT plan</h2>
      <div className="rounded-xl border border-line bg-surface p-4">
        {status.data === undefined && status.error ? (
          <Problem error={status.error} retry={() => void status.refetch()} />
        ) : account === "signed_in" ? (
          <p>
            Rufi's AI uses your ChatGPT plan
            {status.data?.email ? ` (${status.data.email})` : ""}.{" "}
            <a
              href="https://chatgpt.com/codex/settings/usage"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Manage usage
            </a>
          </p>
        ) : (
          account && (
            <p>
              {account === "signed_out"
                ? "Not signed in. Rufi's AI needs your ChatGPT plan to answer."
                : "You are signed in, but ChatGPT plan use isn't allowed for Rufi."}{" "}
              <Link to="/sign-in" className="underline">
                {account === "signed_out" ? "Sign in" : "Sign in again"}
              </Link>
            </p>
          )
        )}
      </div>
    </>
  );
}

/** The model and effort Rufi's reader reads documents with. */
function DocumentsSection() {
  const settings = useSettings();
  const save = useMutation({ mutationFn: saveSettings });
  const reader = settings.data?.reader;
  return (
    <>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">Documents</h2>
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        {reader && (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="reader-model" className="font-medium">
                Reader model
              </label>
              <select
                id="reader-model"
                value={reader.model}
                disabled={save.isPending}
                onChange={(event) => {
                  save.mutate({ readerModel: event.target.value });
                }}
                className="w-64 rounded-lg border border-line bg-surface px-2 py-1.5"
              >
                {reader.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3">
              <span id="reader-effort" className="font-medium">
                Effort
              </span>
              <div
                role="radiogroup"
                aria-labelledby="reader-effort"
                className="inline-flex rounded-lg border border-line bg-side p-0.5"
              >
                {EFFORTS.map((effort) => (
                  <label
                    key={effort.id}
                    className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
                  >
                    <input
                      type="radio"
                      name="reader-effort"
                      value={effort.id}
                      checked={reader.effort === effort.id}
                      disabled={save.isPending}
                      onChange={() => {
                        save.mutate({ readerEffort: effort.id });
                      }}
                      className="absolute inset-0 m-0 cursor-pointer opacity-0"
                    />
                    {effort.name}
                  </label>
                ))}
              </div>
            </div>
            <p className="text-muted">
              Rufi reads documents with this model, as soon as you add them. A
              reading that runs keeps the model and effort it started with.
            </p>
          </>
        )}
        {save.error && (
          <p role="alert" className="text-muted">
            {save.error.message}
          </p>
        )}
      </div>
    </>
  );
}

function BackupsSection() {
  const backups = useBackups();
  const backUp = useMutation({
    mutationFn: () => read(Backups, "POST", "/api/backups"),
    onSuccess: (status) => queries.setQueryData(["backups"], status),
  });
  const status = backups.data;
  return (
    <>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">Backups</h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        {status === undefined && backups.error ? (
          <Problem error={backups.error} retry={() => void backups.refetch()} />
        ) : (
          status && (
            <>
              <p>
                {status.last
                  ? `Last backup ${printedTime(status.last.createdAt)}. `
                  : !status.running && "No backup yet. "}
                Rufi makes one when it starts, then each day while it runs.
              </p>
              {status.failed && (
                <p role="alert" className="text-accent-ink">
                  The last try failed {printedTime(status.failed.at)}:{" "}
                  {status.failed.reason}.{" "}
                  {status.last
                    ? `Your last good backup is from ${printedTime(status.last.createdAt).replace(/^at /, "")}.`
                    : "There is no good backup yet."}
                </p>
              )}
              <Button
                className="self-start"
                disabled={status.running || backUp.isPending}
                onClick={() => {
                  backUp.mutate();
                }}
              >
                <DatabaseBackup size={15} aria-hidden />
                {status.running || backUp.isPending
                  ? "Backing up…"
                  : "Back up now"}
              </Button>
              {/* The same minute as the last one shows no change above. */}
              {backUp.data?.failed === null && !backUp.isPending && (
                <p role="status" className="text-muted">
                  Backed up just now.
                </p>
              )}
              {backUp.error && (
                <p role="alert" className="text-muted">
                  {backUp.error.message}
                </p>
              )}
            </>
          )
        )}
      </div>
    </>
  );
}

function ExportSection() {
  const exported = useMutation({ mutationFn: () => download("/api/export") });
  return (
    <>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">Export</h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <p>
          One zip with everything in your record, your chat and Rufi's settings.
        </p>
        <Button
          className="self-start"
          disabled={exported.isPending}
          onClick={() => {
            exported.mutate();
          }}
        >
          <Download size={15} aria-hidden />
          {exported.isPending ? "Exporting…" : "Export my data"}
        </Button>
        {/* The page can't know the name chosen in the save dialog. */}
        {exported.isSuccess && (
          <p role="status" className="text-muted">
            Exported your data as a zip.
          </p>
        )}
        {exported.error && (
          <p role="alert" className="text-muted">
            {exported.error.message}
          </p>
        )}
      </div>
    </>
  );
}
