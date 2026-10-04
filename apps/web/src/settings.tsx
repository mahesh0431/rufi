// Settings: for now, the region whose emergency number the AI gives.
import { type SaveSettings, Settings } from "@rufi/contracts";
import { useMutation } from "@tanstack/react-query";
import { read } from "./api.ts";
import { queries, useSettings } from "./reads.ts";
import { Problem } from "./ui.tsx";

export function SettingsPage() {
  const settings = useSettings();
  const save = useMutation({
    mutationFn: (emergencyRegion: string | null) =>
      read(Settings, "PUT", "/api/settings", {
        emergencyRegion,
      } satisfies typeof SaveSettings.Type),
    onSuccess: (saved) => queries.setQueryData(["settings"], saved),
  });

  return (
    <div className="mx-auto max-w-[620px] px-6 py-8">
      <h2 className="mb-2 px-0.5 font-semibold">Emergency</h2>
      <div className="rounded-xl border border-line bg-white p-4">
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
                className="w-64 rounded-lg border border-line bg-white px-2 py-1.5"
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
    </div>
  );
}
