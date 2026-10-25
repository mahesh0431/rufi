// Settings → Device data (docs/help/device-data.md): each device source
// with what Rufi has from it and what holds it back, and how long values
// are kept. Shown only when a device source exists. A shorter time says what
// it deletes and deletes only once confirmed.
import type { DeviceSource } from "@rufi/contracts/devices";
import { KeepPreview, type KeepValues } from "@rufi/contracts/devices";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, X } from "lucide-react";
import { read } from "./api.ts";
import { printedDay, printedTime } from "./dates.ts";
import { queries, saveSettings, useDevices, useSettings } from "./reads.ts";
import { Button } from "./ui.tsx";

const SYSTEMS = { apple_health: "Apple Health" } as const;

const KEEPS: readonly { value: KeepValues; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "12m", label: "12 months" },
  { value: "forever", label: "Forever" },
];
const LENGTH: Record<KeepValues, number> = { "30d": 0, "12m": 1, forever: 2 };

const counted = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** What a failed batch's reason asks of the person. */
function failedWords(reason: string): string {
  if (reason === "disk_full") {
    return " because the disk is full. Free some space on your Mac; Rufi tries again every hour.";
  }
  if (reason === "io_error") {
    return " because your Mac couldn't read or write its disk. Rufi tries again every hour.";
  }
  return `. This may need a fix in Rufi. Code: ${reason}.`;
}

function SourceLine({ source }: { source: DeviceSource }) {
  const system = SYSTEMS[source.system];
  const parts = [
    `${system} on ${source.name}`,
    counted(source.values, "value", "values"),
    ...(source.lastBatchAt === null
      ? []
      : [`last batch ${printedTime(source.lastBatchAt).replace(/^at /, "")}`]),
    ...(source.skipped > 0
      ? [`${counted(source.skipped, "value", "values")} skipped`]
      : []),
  ];
  const waits = counted(source.waiting, "batch waits", "batches wait");
  return (
    <li className="flex flex-col gap-0.5">
      <p>{parts.join(" · ")}</p>
      {source.failed ? (
        <p role="alert" className="text-accent-ink">
          {source.person.name}'s {system} is stopped: a batch from this device
          couldn't be converted{failedWords(source.failed.reason)} {waits}.
        </p>
      ) : source.waitsBehind !== null ? (
        <p className="text-muted">
          {waits} behind the failure on {source.waitsBehind}.
        </p>
      ) : (
        source.waiting > 0 && (
          <p className="text-muted">
            Converting: {counted(source.waiting, "batch", "batches")} to go.
          </p>
        )
      )}
    </li>
  );
}

export function DeviceDataSection() {
  const devices = useDevices();
  const settings = useSettings();
  // A shorter time, waiting for the confirm, with what it deletes.
  const [asked, setAsked] = useState<{ keep: KeepValues } & KeepPreview>();
  const save = useMutation({
    mutationFn: (keep: KeepValues) => saveSettings({ deviceKeepValues: keep }),
    onSuccess: () => {
      setAsked(undefined);
      void queries.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const preview = useMutation({
    mutationFn: (keep: KeepValues) =>
      read(KeepPreview, "GET", `/api/devices/preview?keep=${keep}`),
    onSuccess: (found, keep) => {
      if (found.values === 0) save.mutate(keep);
      else setAsked({ keep, ...found });
    },
  });
  const sources = devices.data?.sources ?? [];
  const kept = settings.data?.deviceKeepValues;
  if (sources.length === 0 || kept === undefined) return null;
  const trouble = devices.data?.trouble ?? null;
  const shown = asked?.keep ?? save.variables ?? kept;
  const busy = save.isPending || preview.isPending;
  const choose = (keep: KeepValues) => {
    // Not disabled while busy: the choice keeps the keyboard's focus.
    if (busy) return;
    if (keep === kept) {
      setAsked(undefined);
      return;
    }
    if (LENGTH[keep] > LENGTH[kept]) save.mutate(keep);
    else preview.mutate(keep);
  };
  return (
    <>
      <h2 className="mt-8 mb-2 px-0.5 font-semibold">Device data</h2>
      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        {trouble !== null && (
          <p role="alert" className="text-accent-ink">
            Rufi couldn't save its work on device data
            {trouble === "disk_full"
              ? " because the disk is full. Free some space on your Mac; Rufi tries again."
              : `. This may need a fix in Rufi. Code: ${trouble}.`}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <SourceLine key={source.id} source={source} />
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <span id="keep-values" className="font-medium">
            Keep values
          </span>
          <div
            role="radiogroup"
            aria-labelledby="keep-values"
            className="inline-flex rounded-lg border border-line bg-side p-0.5"
          >
            {KEEPS.map((choice) => (
              <label
                key={choice.value}
                className="relative rounded-md px-3 py-0.5 text-muted has-checked:bg-surface has-checked:text-ink has-checked:shadow-sm has-focus-visible:outline-2 has-focus-visible:outline-accent"
              >
                <input
                  type="radio"
                  name="keep-values"
                  value={choice.value}
                  checked={shown === choice.value}
                  onChange={() => {
                    choose(choice.value);
                  }}
                  className="absolute inset-0 m-0 cursor-pointer opacity-0"
                />
                {choice.label}
              </label>
            ))}
          </div>
        </div>
        {asked && asked.before !== null ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-page p-3">
            <p>
              This deletes {counted(asked.values, "value", "values")} measured
              before {printedDay(asked.before)}, for everyone in this data
              folder. Some may still be in older backups.
            </p>
            <div className="flex gap-2">
              <Button
                icon={X}
                disabled={save.isPending}
                onClick={() => {
                  setAsked(undefined);
                }}
              >
                Cancel
              </Button>
              <Button
                look="delete"
                icon={Trash2}
                busy={save.isPending && "Deleting…"}
                onClick={() => {
                  save.mutate(asked.keep);
                }}
              >
                Delete
              </Button>
            </div>
            <p className="text-muted">
              Nothing changes until you confirm; then Rufi deletes them at
              once. A longer time saves at once, but what was deleted doesn't
              come back.
            </p>
          </div>
        ) : (
          <p className="text-muted">
            For everyone in this data folder. Values are what Rufi keeps from
            your devices, such as your resting heart rate each day. Each batch
            is also kept as it came for 30 days after Rufi converts it; a batch
            with skipped values is kept until it is deleted. Older backups may
            still hold what was deleted until Rufi prunes them.
          </p>
        )}
        {(save.error ?? preview.error) && (
          <p role="alert" className="text-muted">
            {(save.error ?? preview.error)?.message}
          </p>
        )}
      </div>
    </>
  );
}
