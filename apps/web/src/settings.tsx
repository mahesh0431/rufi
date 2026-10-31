// Settings: how Codex and Claude are signed in, how Rufi looks, when a reply's
// Activity opens by itself, what a message sent while a reply runs does,
// how often Rufi carries on
// after a restart, the region whose
// emergency number the AI gives, the model and effort documents are read
// with, device data, backups, the export of your data, and where Rufi keeps it.
import { Backups, DataFolder } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DatabaseBackup, Download, FolderOpen } from "lucide-react";
import { download, read } from "./api.ts";
import { AppearanceChoice } from "./appearance.tsx";
import { DeviceDataSection } from "./devices.tsx";
import { SettingChoice } from "./choice.tsx";
import { printedTime } from "./dates.ts";
import {
  queries,
  saveSettings,
  useBackups,
  useDataFolder,
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
      <h2 id="activity" className="mt-8 mb-2 px-0.5 font-semibold">
        Activity
      </h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <SettingChoice
          setting="activity"
          label="Activity"
          labelledBy="activity"
          choices={[
            { value: "working", label: "Show while working" },
            { value: "shown", label: "Always show" },
            { value: "hidden", label: "Always hide" },
          ]}
        />
        <p className="text-muted">
          What the AI did for each reply: its notes, its thinking and its steps.
          Show while working opens it while the AI works and folds it when the
          answer comes. Always show keeps it open after the answer. Always hide
          keeps it folded, with one line while the AI works. You can fold or
          open it under any reply.
        </p>
      </div>
      <h2 id="while-replying" className="mt-8 mb-2 px-0.5 font-semibold">
        Sending while Rufi replies
      </h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        <SettingChoice
          setting="whileReplying"
          label="Sending while Rufi replies"
          labelledBy="while-replying"
          choices={[
            { value: "steer", label: "Steer" },
            { value: "queue", label: "Queue" },
          ]}
        />
        <p className="text-muted">
          What Enter does while a reply runs. Steer puts your message into that
          reply. Queue keeps it until the reply ends, then it goes in its own.
          Either way, ⌘Enter does the other.
        </p>
      </div>
      <RestartSection />
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
      <DeviceDataSection />
      <BackupsSection />
      <ExportSection />
      <DataFolderSection />
    </div>
  );
}

/** How Codex and Claude are signed in, each as it says, or the way to sign in. */
function PlanSection() {
  const status = useStatus();
  const codex = status.data?.codex;
  const claude = status.data?.claude;
  return (
    <>
      <h2 className="mb-2 px-0.5 font-semibold">Sign-in</h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        {status.data === undefined && status.error ? (
          <Problem error={status.error} retry={() => void status.refetch()} />
        ) : (
          <>
            {codex?.state === "signed_in" ? (
              <p>
                Codex is signed in with ChatGPT
                {codex.account === null ? "" : ` (${codex.account})`}. Rufi's AI
                uses your ChatGPT plan.{" "}
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
              codex && (
                <p>
                  {codex.state === "signed_out"
                    ? "Codex isn't signed in. Rufi's AI needs it to answer."
                    : codex.text}{" "}
                  <Link to="/sign-in" className="underline">
                    Sign in
                  </Link>
                </p>
              )
            )}
            {claude &&
              (claude.state === "signed_in" ? (
                <p>Claude is signed in.</p>
              ) : (
                <p>
                  {claude.state === "signed_out"
                    ? "Claude isn't signed in."
                    : claude.text}{" "}
                  {claude.state === "signed_out" && (
                    <Link to="/sign-in" className="underline">
                      Sign in
                    </Link>
                  )}
                </p>
              ))}
          </>
        )}
        <p className="text-muted">
          The AI can use the internet from its own folder, such as to look
          something up or to install what a program needs. It reaches your
          health record only through Rufi.
        </p>
      </div>
    </>
  );
}

/** How many restarts in a row Rufi carries on a reply that ran. */
function RestartSection() {
  const settings = useSettings();
  const save = useMutation({ mutationFn: saveSettings });
  const continues = settings.data?.continuesAfterRestart;
  return (
    <>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">After a restart</h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        {continues !== undefined && (
          <div className="flex items-center gap-2">
            <label htmlFor="continues" className="font-medium">
              Carry on up to
            </label>
            <select
              id="continues"
              value={continues}
              disabled={save.isPending}
              onChange={(event) => {
                save.mutate({
                  continuesAfterRestart: Number(event.target.value),
                });
              }}
              className="rounded-lg border border-line bg-surface px-2 py-1.5"
            >
              {Array.from({ length: 11 }, (_, count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <span>times in a row</span>
          </div>
        )}
        <p className="text-muted">
          When Rufi stops suddenly while the AI or its agents work, they carry
          on when Rufi starts again. After this many restarts in a row, they
          stop instead, and your waiting messages wait for you to send them. 0:
          they never carry on by themselves.
        </p>
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
                icon={DatabaseBackup}
                className="self-start"
                busy={(status.running || backUp.isPending) && "Backing up…"}
                onClick={() => {
                  backUp.mutate();
                }}
              >
                Back up
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
          One zip with everything in your health record, your chat and Rufi's
          settings.
        </p>
        <Button
          icon={Download}
          className="self-start"
          busy={exported.isPending && "Exporting…"}
          onClick={() => {
            exported.mutate();
          }}
        >
          Export
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

/** How the data folder was chosen, in a sentence. */
const SOURCES = {
  default: "Rufi made this folder for your data on its first start.",
  moved: "You moved your data to this folder.",
  RUFI_HOME:
    "RUFI_HOME chose this folder when Rufi started. Without it, Rufi uses the folder it remembers.",
} as const;

/** Where Rufi keeps your data, and Show in Finder. */
function DataFolderSection() {
  const folder = useDataFolder();
  const show = useMutation({
    mutationFn: () => read(DataFolder, "POST", "/api/data-folder/show"),
  });
  return (
    <>
      <h2 id="data-folder" className="mt-8 mb-2 px-0.5 font-semibold">
        Data folder
      </h2>
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
        {folder.data === undefined && folder.error ? (
          <Problem error={folder.error} retry={() => void folder.refetch()} />
        ) : (
          folder.data && (
            <>
              <p className="font-mono break-all select-text">
                {folder.data.path}
              </p>
              <p className="text-muted">
                {SOURCES[folder.data.source]} To move it, see{" "}
                <Link
                  to="/help/$page"
                  params={{ page: "your-data-and-the-ai" }}
                  hash="move-your-data"
                  className="underline"
                >
                  Move your data
                </Link>
                .
              </p>
              <Button
                icon={FolderOpen}
                className="self-start"
                disabled={show.isPending}
                onClick={() => {
                  show.mutate();
                }}
              >
                Show in Finder
              </Button>
              {show.error && (
                <p role="alert" className="text-muted">
                  {show.error.message}
                </p>
              )}
            </>
          )
        )}
      </div>
    </>
  );
}
