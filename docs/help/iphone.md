# iPhone

Rufi on your iPhone opens your own record from Rufi on your Mac, through Tailscale, and sends your heart data from Apple Health to it. You pair it once in [Settings › iPhone](rufi:/settings/iphone). This page says what pairing needs, how to pair, what the iPhone shows and keeps, how its medicine reminders work, how Rufi and its testing build Rufi Dev keep apart, how to unpair, and what to do when something fails.

## What pairing needs

- **Tailscale** on your Mac and your iPhone, signed in to the same tailnet. Rufi reaches your Mac only through it: nothing else on the internet or your network can reach this door.
- **HTTPS turned on** for your tailnet: in the Tailscale admin console, on the DNS page.
- **Your Mac awake, with Rufi running**, whenever you use Rufi on the iPhone.

## Pair an iPhone

1. Open [Settings › iPhone](rufi:/settings/iphone) and click **Pair an iPhone**.
2. With more than one person in this data folder, choose whose record the iPhone opens. Pair a phone for your own record only for now: Rufi AI on the phone can read every person's files in this folder.
3. Rufi sets up Tailscale for it and checks that it can reach itself through Tailscale. Then it shows a QR code and **Copy link**.
4. On the iPhone, open Rufi and tap **Scan Code** to scan it, or copy the link on the Mac and tap **Paste**. The code works once, for 10 minutes. When the phone has paired, Settings says **Paired: Asha's iPhone, for Asha**.
5. The iPhone says which Mac it paired with and whose record it opens. Tap **Continue**.
6. It offers **Lock Rufi** (below), then **Turn On Reminders** (you can log each dose from a reminder), which asks iOS to let Rufi send notifications. **Not Now** skips either; both are in **This iPhone** later.

**Close** before a phone pairs ends the code. Each paired iPhone has its own line: its name, whose record, when it paired, and when Rufi last saw it.

A paired iPhone opens only that person's record, for good. To open another person's record, pair again for them.

Pairing that person's first iPhone makes their medicine reminders ring on it, and no longer on the Mac. To have them on both, choose **Both** under **Reminders** (see [Medicine reminders on the iPhone](#medicine-reminders-on-the-iphone)). Pairing another iPhone for them keeps what they chose.

## Lock Rufi

After pairing, the iPhone offers **Lock Rufi**: Rufi then asks for Face ID, or your iPhone's passcode, when you open it and after more than a minute away. While Rufi isn't on screen, the app switcher shows a blank page instead of your record. Turn it on or off in **This iPhone** (at the bottom of the sidebar). It needs a passcode on the iPhone: without one, the switch is off and says so.

iOS can also lock any app (touch and hold its icon, then **Require Face ID**). If you use that for Rufi, turn **Lock Rufi** off, so you aren't asked twice.

## On the iPhone

Your picture at the top left (your initials) opens the **sidebar**, or swipe from the left edge of the screen. It has the Mac's places in the Mac's order: **Chat with Rufi**, **Overview**, your health record's pages with how many each has (empty ones grey), **Follow-ups**, **Documents** and **Help**. The place you are in is marked. Tap one to go there; tap beside the sidebar, or swipe it left, to close it. At its bottom, your name and **This iPhone**. Settings is on the Mac only.

The pages come from Rufi on your Mac, as they are there now: what you do on the phone is done on the Mac. A link to another page opens it on top, with its own name at the top (for example **HbA1c**) and **Back** (or a swipe from the left edge) to return; a link in a reply opens the result over the chat, with Back to the chat. In the chat over a page too, a link opens on top, even one to a row of that page; Back shows the page with the chat open again. A link to one of the sidebar's places goes to that place. Web links open in Safari.

**The chat bar.** The pages where you read your health have the chat bar at the bottom, as on the Mac: Overview, the health record's pages, Follow-ups, Documents, a document, a test, a visit and a visit brief. **Ask Rufi** on a row puts it in the bar, which lights up a moment; the page stays. **Send** in the bar sends, and the page stays. Tap the bar to open the chat over the page, with the keyboard and the model to use; the arrow down, or a swipe down on its top, goes back to the page as you left it, and the arrows at its top right open **Chat with Rufi**. To put the keyboard away, swipe down on the page. This iPhone, Reminders and Help have no bar. On a document, **View original** shows the file as it came in iOS's own viewer, every photo of it too, with its share button; Rufi deletes its copy when you close it.

To add a paper report from the chat, tap the scan button beside the paperclip: iOS's document camera finds the page's edges and straightens it. Scan each page, then tap **Save**: the pages go to your Mac together as one document, and its chip appears in the box, as when you add photos with the paperclip. Rufi reads it when you send; if you go to another place meanwhile, the chip is in the box when you come back. If the camera can't take the scan, Rufi says so, adds no pages and keeps your words: scan again. The paperclip still adds photos and files.

Text follows the iPhone's Text Size (Settings › Accessibility › Display & Text Size), and Rufi follows the iPhone's light or dark appearance, in the colour theme chosen on the Mac (Settings › Appearance there); the sidebar and This iPhone take it too. A theme changed on the Mac shows the next time Rufi opens on the iPhone. Rufi's own text size and light or dark setting are for the Mac.

Settings, sign-in and backups are on the Mac only.

## Medicine reminders on the iPhone

When that person's reminders ring on the **iPhone** or **Both**, Rufi on the iPhone rings them itself, at each medicine's times, as Rufi's own notices. They aren't Apple's Medications reminders.

- **One notice per time**, with every medicine due then. Rufi's notices stack together in Notification Center.
- **What it says** is the person's choice under **Reminders** (the bell at the top right of Medicines, or on the Mac's Medicines page): **Just the time** ("Medicines at 21:00"), **How many** ("2 medicines at 21:00"), or **Which ones** ("21:00 · 2 medicines", then each name, strength and amount). On the Lock Screen, Which ones shows names unless the iPhone's Settings › Notifications › Show Previews is **When Unlocked**; then it shows "Medicine reminder" until you unlock.
- **Where reminders ring:** **iPhone**, **Mac** or **Both**, in the same place. With **Mac**, the iPhone has no medicine notices.
- **Times are where you are.** A medicine at 08:00 rings at 08:00 on the iPhone's clock, also when you travel.
- They are **Time Sensitive**, so a Focus doesn't hold them back. To change that, open Settings › Notifications › Rufi on the iPhone (Rufi Dev for a testing build).
- Tap a notice to open Rufi at **Medicines**, after Lock Rufi.

### Log a dose from a reminder

Touch and hold a reminder, then tap **Taken** or **Skipped**. It needs the iPhone unlocked, not Lock Rufi, and works with Rufi closed. A paired Apple Watch shows the same.

- **Taken** or **Skipped** logs every medicine on that reminder. To log only one, tap the reminder: Rufi opens at **Medicines**, where **Today** logs each on its own.
- The log goes to your Mac at once and shows on its **Today** as, for example, **Taken 21:02 · iPhone**. If the Mac can't be reached, the iPhone keeps it and sends it the next time Rufi reaches the Mac (when you open it, or in the background). It is never counted twice, even when it is sent again.
- To change a log, use **Undo** on Today.

**Not on your Mac yet.** Doses you logged that your Mac doesn't have yet are listed in **This iPhone**, with how many on **Can't Reach Your Mac**. Swipe one left to **Discard** it: it is never sent. If your Mac refuses one, it says so there and isn't sent again. They stay if the iPhone is unpaired: they are sent only when you pair again for the same person with Rufi on the same Mac, and never to another pairing. Until then they show on the unpaired screen, and Lock Rufi stays on while any wait. Deleting the app deletes them.

**Set until.** The iPhone gets its reminders from your Mac for the next week, and the next time after it (so a medicine you take once a month still rings), and keeps them when it can't reach the Mac. **This iPhone** shows until when they are set, for example "Set until Thu 5 Nov, 21:00", and so does **Can't Reach Your Mac**. The iPhone gets them again each time you open Rufi, when you leave it, and now and then in the background when iOS allows. If you don't open Rufi for a week, a last notice, **Open Rufi to keep your reminders coming**, rings a minute after the last one set.

After you change a medicine's times or reminders on the Mac, open Rufi on the iPhone, so it rings the new ones: until then it rings what it had. With Rufi open on the iPhone, it follows at once. A dose you logged, on the iPhone or the Mac, rings no more, and its notice leaves Notification Center the next time the iPhone gets its reminders, as do notices for a medicine you stopped or retimed, and ones older than yesterday.

If nothing rings, check **This iPhone**: **Notifications** says whether iOS lets Rufi ring, with a way to turn them on.

## Apple Health

In **This iPhone** › **Apple Health**, connect Apple Health, see your latest resting heart rate and heart rate, and tap **Sync for Asha** (with the paired person's name) to send your heart data to Rufi on your Mac. See [Device data](device-data.md#apple-health-from-your-iphone) for how it works and what each line means.

## What the iPhone keeps

- Its key, in the iPhone's keychain, on this iPhone only.
- Which Mac it paired with and whose record it opens, and whether Lock Rufi is on.
- Its medicine reminders for the next week, as iOS notices: the times and the medicines, whatever a notice shows.
- Doses you logged that aren't on your Mac yet: each medicine's name and strength, the dose's time, taken or skipped, and which Mac and person it is for. They aren't in the iPhone's backups.
- For Apple Health: where each kind of heart data was sent up to (Apple's bookmark, not the values), and when the last sync was and how many readings it sent.
- Rufi's own files (the scripts and styles its pages are drawn with, none of your record), so it opens without fetching them from your Mac again, and the colour theme's colours.

Nothing of your record, chat, documents or heart data is kept by Rufi on the iPhone (your heart data stays in Apple Health, where it was): pages are shown while Rufi is open and gone when it closes, and an original you view is a temporary copy, deleted when you close it (or the next time Rufi starts, if it was closed while showing one); scanned pages go straight to your Mac without being saved on the iPhone. Deleting the app deletes all of this; to use Rufi on that iPhone again, pair it again.

## Rufi and Rufi Dev

Testing builds of the iPhone app are named **Rufi Dev**. Rufi and Rufi Dev are separate apps and can both be on one iPhone. Each one pairs on its own, with its own line in Settings › iPhone, and keeps what it keeps on its own: its key, Lock Rufi, reminders, Apple Health bookmarks and doses not on your Mac yet. Nothing moves from one to the other. When both are paired for the same person, both ring that person's reminders; unpair the one you don't use. Where this page says Rufi on the iPhone, it means whichever of the two you opened, also in the iPhone's own Settings.

## When your Mac can't be reached

If your Mac is asleep, Rufi isn't running there, or Tailscale is off on either, the iPhone says **Can't Reach Your Mac** with **Try Again**, and until when its reminders are set; they keep ringing. If the Mac becomes unreachable while Rufi is open, a line says **Can't reach your Mac. Checking again every few seconds.** and the page comes back by itself when it can. What you were typing stays.

If the iPhone says to update Rufi on your iPhone or on your Mac so they match, they were built for different versions: update the older one.

## Unpair

On the Mac: click **Unpair** on its line, then **Unpair** again. From then on it can't open Rufi, and anything it has open ends at once. What it sent stays on your Mac. If you lose your phone, unpair it here. When it was that person's last iPhone, their reminders ring on the Mac. Reminders already on the iPhone can still ring until it next reaches your Mac, at most a week. The next time Rufi on that iPhone reaches the Mac, it removes its reminders and says it was unpaired, with **Pair Again**.

On the iPhone: in **This iPhone**, tap **Unpair This iPhone**, then confirm. A sync running stops first. The iPhone forgets its key and its Apple Health bookmarks, removes its reminders, and the Mac stops letting it in. Doses not on your Mac yet stay (see [Log a dose from a reminder](#log-a-dose-from-a-reminder)).

When nothing is paired and no code is waiting, Rufi stops listening for phones and removes its Tailscale route.

## When a step fails

Settings says what went wrong in one line, and shows no code:

- **Rufi reaches your iPhone through Tailscale. Install it and sign in on this Mac and your iPhone, then try again.** Install Tailscale from tailscale.com.
- **Tailscale isn't connected on this Mac.** Open Tailscale on the Mac and sign in.
- **Turn on HTTPS in your Tailscale admin console (DNS page), then try again.**
- **Tailscale couldn't serve Rufi: …** followed by Tailscale's own words. If it says Serve isn't enabled on your tailnet, open the link it gives and enable it, then try again.
- **Rufi couldn't reach itself through Tailscale.** The first time can take a while, while Tailscale gets a certificate for your Mac. Try again in a minute.
- **Rufi can't open its iPhone port (…): another app is using it.** Quit that app and restart Rufi.

## After a restore

A restored copy of your data has no paired iPhones: each must pair again (see [Backups and export](backups-and-export.md#restore-a-backup)).
