# Device data

Device data is what your devices measure, such as your heart rate through the day and your resting heart rate each day, from Apple Health. Rufi keeps it apart from your health record: nobody confirms each value in the chat, and the AI doesn't read it yet. Nothing in Rufi shows it yet except **Settings → Device data**. This page says what Rufi keeps, how long, and what Settings tells you.

Rufi's phone app, which will send it, isn't ready yet. Until then, a developer can put fictional device data in with the terminal (see [For developers](#for-developers)).

## What Rufi keeps

- **Device sources.** A source is one device, such as your iPhone, connected for one person for good. Its data goes only into that person's device data.
- **Batches.** The device sends what it has in batches. Rufi stores each batch first, exactly as it came, then converts it in the background while Rufi runs.
- **Values.** Each thing measured, in Rufi's terms: what it is (for now, heart rate or resting heart rate), the number and unit, when it was measured, and the device. When the device knows where you were, the time zone too; without it, Rufi doesn't know your local day, and doesn't guess. For heart rate, also whether you were resting or active, as Apple Health says. During a workout, Apple Health may keep several readings as one value with their average: Rufi keeps each reading with its own time in that value.

Rufi keeps values as they were sent: it doesn't judge whether a number is likely. When Apple Health takes a value back (it often replaces a day's first estimate with a better one), Rufi marks that value removed.

A day with no value means nothing was measured or sent that day, not zero.

## Settings → Device data

The section shows once a device source exists. Each source has one line: the system and the device, how many values Rufi has from it, when its last batch came, and how many values it sent that Rufi couldn't read (skipped).

- **Converting: 3 batches to go.** Rufi is converting batches that came in. It does this by itself while Rufi runs.
- **Skipped values.** A value Rufi couldn't read (a unit it doesn't take, a missing time, a type it doesn't know yet) is skipped, and the rest of its batch converts. Rufi keeps that batch, exactly as it came, so the data isn't lost.
- **Stopped.** When a batch can't be converted at all, for example because the disk is full, Rufi stops that person's batches from that system, so they stay in order, and says how many wait. Rufi tries again by itself after half a minute, a minute and two minutes, then every hour and each time it starts. If the disk is full, free some space on your Mac. If it says **This may need a fix in Rufi**, it gives a code to quote when you report it.
- **Waiting behind.** Another device of the same person waits behind the stopped one, so it never takes back a value before that value is in.

## Keep values

**Keep values** says how long Rufi keeps device values: **30 days**, **12 months** or **Forever** (the first choice). It is for everyone in this data folder. Values are aged by when they were measured: 30 days is the last 30 × 24 hours, 12 months the last 365 days.

When you choose a shorter time, Rufi says how many values it would delete, measured before which day, and asks. Nothing changes until you click **Delete**; then Rufi deletes them at once, and from then on doesn't keep values older than that. Years of values take a minute or so: Settings says **Deleting values older than you keep…** meanwhile, and you can go on using Rufi. **Cancel** keeps everything. A longer time saves at once, but what was deleted doesn't come back.

Rufi keeps each batch as it came for 30 days after converting it, then deletes it; the values stay. A batch with skipped values is kept until it is deleted.

Older backups still hold what was deleted until Rufi prunes them, and the backup made before an upgrade keeps it until you delete it (see [Backups and export](backups-and-export.md)). Values that came in since the last backup are in none.

## What Rufi can't know

- A value the device deleted before it sent anything never reaches Rufi.
- A value without a time zone has no local day.
- A missing day is unknown, not zero.

## For developers

With Rufi closed, and `RUFI_HOME` set to a fictional data folder:

1. `pnpm rufi device-source add "Asha's iPhone" --system apple_health --person asha` makes a source and prints its ID. Leave out `--person` only when the folder has one person; otherwise nothing is made, and the command lists who is there.
2. `pnpm rufi device-import <file> --source <id>` takes a file with one batch per line, as the phone will send them. It prints **got it** or **already got** for each line, and stops at the first line it refuses, saying why. What came before stays; fix the line and run it again.
3. Start Rufi: it converts the batches. `pnpm rufi device-source list` shows each source with its values and waiting batches.

A batch is at most 4 MB and 5,000 values and deletions. In `apps/server/tests/fixtures/device/`, `asha-heart-rate.jsonl` is a fictional day of heart rate with a workout's condensed readings, and `asha-resting-heart-rate.jsonl`: 60 days for Asha, with a trip to London over the clock change, a day without its time zone, a value Apple rewrote and one with a unit Rufi doesn't take.
