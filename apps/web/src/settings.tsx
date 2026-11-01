// Settings, a pop-up over the page you are on (settings-link.tsx says how it
// opens), its options in groups: Sign-in (how Codex and Claude are signed
// in), Profile (about you, and the region whose emergency number the AI
// gives, and the profile's history), Appearance (light or dark, the colour
// theme, and how a reply sits in the chat), Chat (when a reply's Activity opens,
// what a message sent while a reply runs does, how often Rufi carries on
// after a restart) and Data (device data, backups, the export of your data,
// and where Rufi keeps it). A change takes effect at once; there is no Save.
import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { Backups, DataFolder } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Database,
  DatabaseBackup,
  Download,
  FolderOpen,
  KeyRound,
  MessageCircle,
  Palette,
  UserRound,
  X,
} from "lucide-react";
import { useState } from "react";
import { download, read } from "./api.ts";
import { AppearanceChoice, ColourChoice } from "./appearance.tsx";
import { DeviceDataSection } from "./devices.tsx";
import { ProfileHistory, ProfileSection } from "./profile.tsx";
import { SettingChoice } from "./choice.tsx";
import { printedTime } from "./dates.ts";
import {
  queries,
  saveSettings,
  useBackups,
  useDataFolder,
  usePeople,
  useSettings,
  useStatus,
} from "./reads.ts";
import {
  type Group,
  GROUPS,
  type Save,
  SettingsSaves,
  useSettingsGroup,
} from "./settings-link.tsx";
import {
  Button,
  ICON,
  type Icon,
  IconButton,
  Problem,
  Section,
} from "./ui.tsx";

const NAMES: Record<Group, { name: string; icon: Icon }> = {
  "sign-in": { name: "Sign-in", icon: KeyRound },
  profile: { name: "Profile", icon: UserRound },
  appearance: { name: "Appearance", icon: Palette },
  chat: { name: "Chat", icon: MessageCircle },
  data: { name: "Data", icon: Database },
};

/**
 * Settings over the page, at the group the address names. Esc, the close
 * button or a click on the page behind closes it; the page stays as it was.
 */
export function SettingsDialog() {
  const group = useSettingsGroup();
  const navigate = useNavigate();
  const show = (next: Group | undefined) =>
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, settings: next }),
      replace: true,
    });
  const [saves] = useState(() => new Map<Save, Group>());
  // What you typed is saved first: the field you are in as when you leave
  // it, then each part's own. One that fails keeps Settings open at it.
  const close = async () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const failed = await Promise.all(
      [...saves].map(([save, at]) =>
        save().then(
          () => undefined,
          () => at,
        ),
      ),
    );
    show(failed.find((at) => at !== undefined));
  };
  return (
    <Dialog.Root
      open={group !== undefined}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <Dialog.Portal>
        {/* Over the chat panel too: a click here doesn't fold it. */}
        <Dialog.Backdrop
          data-over-chat
          className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-[5px]"
        />
        <Dialog.Popup
          data-over-chat
          className="fixed top-1/2 left-1/2 z-40 flex h-[min(90vh,56rem)] w-[min(90vw,68rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[14px] bg-surface shadow-menu outline-none"
        >
          {group !== undefined && (
            <Tabs.Root
              value={group}
              onValueChange={(next: Group) => {
                show(next);
              }}
              orientation="vertical"
              className="flex min-w-0 flex-1"
            >
              <div className="flex w-48 shrink-0 flex-col border-r border-line bg-side p-2.5">
                <Dialog.Title className="px-2 pt-1 pb-3 text-[0.9375rem] font-semibold">
                  Settings
                </Dialog.Title>
                <Tabs.List activateOnFocus className="flex flex-col gap-0.5">
                  {GROUPS.map((id) => {
                    const { name, icon: Glyph } = NAMES[id];
                    return (
                      <Tabs.Tab
                        key={id}
                        value={id}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-accent data-active:bg-accent-soft data-active:text-accent-ink"
                      >
                        <Glyph size={ICON} aria-hidden />
                        {name}
                      </Tabs.Tab>
                    );
                  })}
                </Tabs.List>
              </div>
              <div className="relative flex min-w-0 flex-1 flex-col">
                <Dialog.Close
                  render={
                    <IconButton
                      label="Close"
                      icon={X}
                      className="absolute top-3 right-3 z-10"
                    />
                  }
                />
                {GROUPS.map((id) => (
                  // Mounted while Settings is open: a change not saved yet
                  // stays in its group, with Retry, when you look at another.
                  <Tabs.Panel
                    key={id}
                    value={id}
                    keepMounted
                    className="min-h-0 flex-1 overflow-auto px-6 pt-5 pb-8 outline-none"
                  >
                    <h3 className="mb-4 text-[0.9375rem] font-semibold">
                      {NAMES[id].name}
                    </h3>
                    <div className="flex flex-col gap-6">
                      <SettingsSaves value={{ saves, group: id }}>
                        <GroupOptions group={id} />
                      </SettingsSaves>
                    </div>
                  </Tabs.Panel>
                ))}
              </div>
            </Tabs.Root>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The options of one group. */
function GroupOptions({ group }: { group: Group }) {
  const person = usePeople().data?.[0];
  switch (group) {
    case "sign-in":
      return <PlanSection />;
    case "profile":
      return (
        <>
          {person && <ProfileSection person={person} />}
          <EmergencySection />
          {person && <ProfileHistory person={person} />}
        </>
      );
    case "appearance":
      return (
        <>
          <Section title="Mode" id="appearance-mode">
            <AppearanceChoice labelledBy="appearance-mode" />
            <p className="text-muted">
              System follows your Mac's light or dark appearance.
            </p>
          </Section>
          <Section title="Colour" id="appearance-colour">
            <ColourChoice labelledBy="appearance-colour" />
            <p className="text-muted">
              Changes at once when you pick it: the background, and the colour
              of buttons, links, what is selected and your own messages.
            </p>
          </Section>
          <Section title="Text size" id="text-size">
            <SettingChoice
              setting="textSize"
              label="Text size"
              labelledBy="text-size"
              choices={[
                { value: "default", label: "Default" },
                { value: "large", label: "Large" },
                { value: "larger", label: "Larger" },
              ]}
            />
            <p className="text-muted">
              All of Rufi's text, Rufi AI's replies too. In the Rufi app, ⌘+ and
              ⌘− zoom the whole window, and ⌘0 puts it back.
            </p>
          </Section>
          <Section title="Rufi's replies" id="reply-shape">
            <SettingChoice
              setting="replyShape"
              label="Rufi's replies"
              labelledBy="reply-shape"
              choices={[
                { value: "flat", label: "Flat" },
                { value: "panel", label: "Panel" },
                { value: "card", label: "Card" },
              ]}
            />
            <p className="text-muted">
              How Rufi AI's reply sits in the chat. Flat: on the chat's
              background. Panel: on its own soft surface. Card: the same, with a
              thin border.
            </p>
          </Section>
        </>
      );
    case "chat":
      return (
        <>
          <Section title="Activity" id="activity">
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
              What the AI did for each reply: its notes, its thinking and its
              steps. Show while working opens it while the AI works and folds it
              when the answer comes. Always show keeps it open after the answer.
              Always hide keeps it folded, with one line while the AI works. You
              can fold or open it under any reply.
            </p>
          </Section>
          <Section title="Sending while Rufi replies" id="while-replying">
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
              What Enter does while a reply runs. Steer puts your message into
              that reply. Queue keeps it until the reply ends, then it goes in
              its own. Either way, ⌘Enter does the other.
            </p>
          </Section>
          <RestartSection />
        </>
      );
    case "data":
      return (
        <>
          <DeviceDataSection />
          <BackupsSection />
          <ExportSection />
          <DataFolderSection />
        </>
      );
  }
}

/** The region whose emergency number the AI gives. */
function EmergencySection() {
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (emergencyRegion: string | null) =>
      saveSettings({ emergencyRegion }),
  });
  return (
    <Section title="Emergency region">
      {settings.data === undefined && settings.error ? (
        <Problem error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        settings.data && (
          <>
            <select
              id="region"
              aria-label="Emergency region"
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
              The AI gives this number when a message may describe an emergency.
              Not set: it says to call your local emergency number.
            </p>
            {save.error && (
              <p role="alert" className="text-muted">
                {save.error.message}
              </p>
            )}
          </>
        )
      )}
    </Section>
  );
}

/** How Codex and Claude are signed in, each as it says, or the way to sign in. */
function PlanSection() {
  const status = useStatus();
  const codex = status.data?.codex;
  const claude = status.data?.claude;
  return (
    <div className="flex flex-col gap-2">
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
        something up or to install what a program needs. It reaches your health
        record only through Rufi.
      </p>
    </div>
  );
}

/** How many restarts in a row Rufi carries on a reply that ran. */
function RestartSection() {
  const settings = useSettings();
  const save = useMutation({ mutationFn: saveSettings });
  const continues = settings.data?.continuesAfterRestart;
  return (
    <Section title="After a restart">
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
        When Rufi stops suddenly while the AI or its agents work, they carry on
        when Rufi starts again. After this many restarts in a row, they stop
        instead, and your waiting messages wait for you to send them. 0: they
        never carry on by themselves.
      </p>
      {save.error && (
        <p role="alert" className="text-muted">
          {save.error.message}
        </p>
      )}
    </Section>
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
    <Section title="Backups">
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
    </Section>
  );
}

function ExportSection() {
  const exported = useMutation({ mutationFn: () => download("/api/export") });
  return (
    <Section title="Export">
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
    </Section>
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
    <Section title="Data folder">
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
    </Section>
  );
}
