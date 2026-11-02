// Reminders on the Medicines page (docs/help/record.md): what a medicine
// reminder shows, and, once an iPhone is paired for the person, where it
// rings. One button with the bell in the page's toolbar opens both; a
// choice is kept as it is picked, and the menu stays open. Which medicines
// remind, and when, change in the chat.
import { Menu } from "@base-ui/react/menu";
import type {
  ReminderRing,
  ReminderShow,
  Reminders,
} from "@rufi/contracts/record";
import { Bell, Check } from "lucide-react";
import { useState } from "react";
import { messageOf } from "./live.ts";
import { saveReminders, useReminders } from "./reads.ts";
import { buttonLook, ICON } from "./ui.tsx";

const POPUP =
  "z-30 w-80 rounded-xl bg-surface/95 p-1.5 shadow-menu backdrop-blur-xl outline-none";
const LABEL = "px-2 pt-1.5 pb-1 text-xs text-muted";
const ITEM =
  "flex cursor-default items-start gap-2 rounded-lg px-2 py-1.5 outline-none select-none data-[highlighted]:bg-side";

const SHOWS: readonly [ReminderShow, string, string][] = [
  ["time", "Just the time", "“Medicines at 21:00”"],
  ["count", "How many", "“2 medicines at 21:00”"],
  ["names", "Which ones", "“21:00 · 2 medicines”, then each"],
];

/** Where they ring; the iPhone's line names the person's iPhones. */
const rings = (setting: Reminders): [ReminderRing, string, string][] => [
  [
    "iphone",
    "iPhone",
    `${setting.iphones.map((app) => app.name).join(", ")}: rings once Rufi's iPhone app is ready`,
  ],
  ["mac", "Mac", "While the Rufi app is open"],
  ["both", "Both", "A backup when the iPhone can't"],
];

function Choice({ name, detail }: { name: string; detail: string }) {
  return (
    <>
      <span className="grid size-4 shrink-0 place-items-center pt-0.5 text-accent">
        <Menu.RadioItemIndicator>
          <Check size={ICON} aria-hidden />
        </Menu.RadioItemIndicator>
      </span>
      <span className="min-w-0">
        {name}
        {detail !== "" && (
          <span className="block text-xs text-muted">{detail}</span>
        )}
      </span>
    </>
  );
}

export function RemindersMenu({ personId }: { personId: string }) {
  const reminders = useReminders(personId);
  const setting = reminders.data;
  const [problem, setProblem] = useState<string>();
  const choose = (choice: Partial<Pick<Reminders, "show" | "ring">>) => {
    if (!setting) return;
    setProblem(undefined);
    saveReminders(personId, {
      show: choice.show ?? setting.show,
      ring: choice.ring ?? setting.ring,
    }).catch((error: unknown) => {
      setProblem(messageOf(error));
    });
  };
  return (
    <Menu.Root
      modal={false}
      // Read again as it opens: pairing or unpairing in Settings, over
      // this page, changes where reminders can ring.
      onOpenChange={(open) => {
        if (open) void reminders.refetch();
      }}
    >
      <Menu.Trigger
        disabled={setting === undefined}
        className={buttonLook({ look: "quiet" })}
      >
        <Bell size={ICON} aria-hidden />
        Reminders
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="end"
          sideOffset={6}
          className="z-30"
        >
          <Menu.Popup className={POPUP}>
            {setting && (
              <>
                <Menu.Group>
                  <Menu.GroupLabel className={LABEL}>
                    A reminder shows
                  </Menu.GroupLabel>
                  <Menu.RadioGroup
                    value={setting.show}
                    onValueChange={(show: ReminderShow) => {
                      if (show !== setting.show) choose({ show });
                    }}
                  >
                    {SHOWS.map(([value, name, detail]) => (
                      <Menu.RadioItem
                        key={value}
                        value={value}
                        closeOnClick={false}
                        className={ITEM}
                      >
                        <Choice name={name} detail={detail} />
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                </Menu.Group>
                {setting.iphones.length > 0 && (
                  <>
                    <Menu.Separator className="my-1 h-px bg-line" />
                    <Menu.Group>
                      <Menu.GroupLabel className={LABEL}>
                        Where reminders ring
                      </Menu.GroupLabel>
                      <Menu.RadioGroup
                        value={setting.ring}
                        onValueChange={(ring: ReminderRing) => {
                          if (ring !== setting.ring) choose({ ring });
                        }}
                      >
                        {rings(setting).map(([value, name, detail]) => (
                          <Menu.RadioItem
                            key={value}
                            value={value}
                            closeOnClick={false}
                            className={ITEM}
                          >
                            <Choice name={name} detail={detail} />
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                    </Menu.Group>
                  </>
                )}
                {problem !== undefined && (
                  <p role="alert" className="px-2 pt-1.5 text-xs text-danger">
                    {problem}
                  </p>
                )}
                <p className="px-2 pt-1.5 pb-1 text-xs text-muted">
                  Which medicines remind you, and when, you change in the chat.
                </p>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
