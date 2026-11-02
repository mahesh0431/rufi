# Device data

Device data is what your devices measure, such as your heart rate through the day and your resting heart rate each day, from Apple Health. Rufi keeps it apart from your health record: nobody confirms each value in the chat, and the AI doesn't read it yet. Nothing in Rufi shows it yet except [Settings › Data](rufi:/settings/data) › **Device data**, and the latest two numbers on your iPhone. This page says how your iPhone sends it, what Rufi keeps, how long, and what Settings tells you.

Rufi on your iPhone sends it (see [Apple Health from your iPhone](#apple-health-from-your-iphone)). A developer can also put fictional device data in with the terminal (see [For developers](#for-developers)).

## Apple Health from your iPhone

Pair Rufi on your iPhone with your Mac first (see [iPhone](iphone.md)). Then, on the iPhone, open **This iPhone** (the dog at the top right of each tab) › **Apple Health**.

1. Tap **Connect Apple Health**. Apple's own sheet asks which heart data Rufi may read: heart rate and resting heart rate. Rufi only reads; it never writes to Apple Health. You can change what you allowed later in Settings › Health › Data Access & Devices › Rufi.
2. The page shows your latest resting heart rate and heart rate, from Apple Health, with when each was measured: **today**, a time, or the date when it isn't from today. During a workout Apple Health may keep many readings as one value: the number shown is the last reading, with its own time.
3. Tap **Sync for Asha** (with the name of the person the iPhone was paired for). Rufi sends everything Apple Health lets it read the first time, then only what is new since. The line under it counts while it sends, then says **Last sent 09:14 · 5,752 readings**, or **Last checked 09:14 · nothing new**. Keep Rufi open meanwhile; the first sync of years of heart data can take a while.

**Stop** stops at once. Nothing is lost or sent twice: the next sync starts after the last part your Mac said it has. The same happens if you leave Rufi, lock the iPhone, or the Mac can't be reached part way; when your Mac had a part already, it keeps it once.

What a sync sends goes into this iPhone's own device source on the Mac, made at its first sync and named as the iPhone, under the person the iPhone was paired for. Rufi on the Mac stores each part as it came and converts it in the background. Values from your Apple Watch that two iPhones both send are kept once.

**Only recent history.** If you allowed Rufi to read only recent history in Apple's sheet, the page says from when, for example **Apple Health lets Rufi read heart rate from 2 Aug 2026.** After you allow more in Settings › Health › Data Access & Devices › Rufi, tap **Read History Again**: Rufi reads everything Apple Health now lets it read and sends it again. What your Mac has stays, and it keeps each value once.

When a sync stops, the page says why in one line:

- **Can't reach your Mac.** Check Rufi is open there, the Mac is awake, and Tailscale is on, on both. Then tap Sync again.
- **Unlock your iPhone to sync.** iOS doesn't let apps read Apple Health while the iPhone is locked.
- **A heart-rate value from 14 Mar 2024 is too large for Rufi on your Mac.** One value, such as a very long workout's readings, is larger than Rufi takes at once (4 MB). Sync stops at it each time; nothing is cut or skipped.
- **Rufi lost its place in Apple Health.** Tap **Read History Again**.
- **Rufi on your Mac couldn't store this.** Look at Settings › Data › Device data on your Mac, for example for a full disk.
- **Rufi on your Mac refused a batch, or Update Rufi on your iPhone (or on your Mac) so they match.** The two were built for different versions: update the older one.

**No heart data from Apple Health** means Rufi found nothing it may read: either there is none, or you didn't allow it. Apple Health doesn't tell apps which.

Unpairing the iPhone, on either side, stops its syncs; what it sent stays on your Mac. After pairing again, the first sync sends everything again, and your Mac keeps each value once. After a restore on your Mac, pair the iPhone again.

## What Rufi keeps

- **Device sources.** A source is one device, such as your iPhone, connected for one person for good. Its data goes only into that person's device data.
- **Batches.** The device sends what it has in batches. Rufi stores each batch first, exactly as it came, then converts it in the background while Rufi runs.
- **Values.** Each thing measured, in Rufi's terms: what it is (for now, heart rate or resting heart rate), the number and unit, when it was measured, and the device. When the device knows where you were, the time zone too; without it, Rufi doesn't know your local day, and doesn't guess. For heart rate, also whether you were resting or active, as Apple Health says. During a workout, Apple Health may keep several readings as one value with their average: Rufi keeps each reading with its own time in that value.

Rufi keeps values as they were sent: it doesn't judge whether a number is likely. When Apple Health takes a value back (it often replaces a day's first estimate with a better one), Rufi marks that value removed.

A day with no value means nothing was measured or sent that day, not zero.

## Settings › Data › Device data

The section shows once a device source exists: an iPhone's first sync makes one. Each source has one line: the system and the device, how many values Rufi has from it, when its last batch came, and how many values it sent that Rufi couldn't read (skipped).

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
- A value Apple Health no longer has can't be sent again.
- A value without a time zone has no local day.
- A missing day is unknown, not zero.

## For developers

With Rufi closed, and `RUFI_HOME` set to a fictional data folder:

1. `pnpm rufi device-source add "Asha's iPhone" --system apple_health --person asha` makes a source and prints its ID. Leave out `--person` only when the folder has one person; otherwise nothing is made, and the command lists who is there.
2. `pnpm rufi device-import <file> --source <id>` takes a file with one batch per line, as the iPhone sends them. It prints **got it** or **already got** for each line, and stops at the first line it refuses, saying why. What came before stays; fix the line and run it again.
3. Start Rufi: it converts the batches. `pnpm rufi device-source list` shows each source with its values and waiting batches.

A batch is at most 4 MB and 5,000 values and deletions. In `apps/server/tests/fixtures/device/`, `phone-batch.json` is one batch as Rufi on the iPhone encodes it, `asha-heart-rate.jsonl` is a fictional day of heart rate with a workout's condensed readings, and `asha-resting-heart-rate.jsonl`: 60 days for Asha, with a trip to London over the clock change, a day without its time zone, a value Apple rewrote and one with a unit Rufi doesn't take.
