// Settings: how Rufi looks, the region whose emergency number the AI gives,
// backups, and the export of your data.
import { Backups } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { DatabaseBackup, Download } from "lucide-react";
import { download, read } from "./api.ts";
import { AppearanceChoice } from "./appearance.tsx";
import { printedTime } from "./dates.ts";
import { queries, saveSettings, useBackups, useSettings } from "./reads.ts";
import { Button, Problem } from "./ui.tsx";

export function SettingsPage() {
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (emergencyRegion: string | null) =>
      saveSettings({ emergencyRegion }),
  });

  return (
    <div className="mx-auto max-w-[620px] px-6 py-8">
      <h2 id="appearance" className="mb-2 px-0.5 font-semibold">
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
      <BackupsSection />
      <ExportSection />
    </div>
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
        {exported.data && (
          <p role="status" className="text-muted">
            Exported {exported.data}.
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
