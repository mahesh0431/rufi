# iPhone

Rufi on your iPhone opens your own record from Rufi on your Mac, through Tailscale. You pair it once in [Settings › iPhone](rufi:/settings/iphone). This page says what pairing needs, how to pair, what the iPhone shows and keeps, how to unpair, and what to do when something fails.

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

**Close** before a phone pairs ends the code. Each paired iPhone has its own line: its name, whose record, when it paired, and when Rufi last saw it.

A paired iPhone opens only that person's record, for good. To open another person's record, pair again for them.

Pairing leaves that person's medicine reminders ringing on the Mac. Under **Reminders** on the Medicines page you can choose **iPhone** or **Both** (see [Reminders](record.md#reminders)); the iPhone doesn't ring yet, so until it does keep **Mac** or **Both** to be reminded.

## Lock Rufi

After pairing, the iPhone offers **Lock Rufi**: Rufi then asks for Face ID, or your iPhone's passcode, when you open it and after more than a minute away. While Rufi isn't on screen, the app switcher shows a blank page instead of your record. Turn it on or off in **This iPhone** (the dog at the top right of each tab). It needs a passcode on the iPhone: without one, the switch is off and says so.

iOS can also lock any app (touch and hold its icon, then **Require Face ID**). If you use that for Rufi, turn **Lock Rufi** off, so you aren't asked twice.

## On the iPhone

Rufi has four tabs: **Chat**, **Medicines**, **Record** and **Documents**. Their pages come from Rufi on your Mac, as they are there now: what you do on the phone is done on the Mac. A link to another page opens it on top, with **Back** (or a swipe from the left edge) to return; a link in a reply opens the result in Chat, with Back to the chat. Web links open in Safari.

Text follows the iPhone's Text Size (Settings › Accessibility › Display & Text Size), and Rufi follows the iPhone's light or dark appearance. Rufi's own text size and appearance settings are for the Mac.

Settings, sign-in and backups are on the Mac only.

## What the iPhone keeps

- Its key, in the iPhone's keychain, on this iPhone only.
- Which Mac it paired with and whose record it opens, and whether Lock Rufi is on.

Nothing of your record, chat or documents is written to the iPhone: pages are shown while Rufi is open and gone when it closes. Deleting the app deletes all of this; to use Rufi on that iPhone again, pair it again.

## When your Mac can't be reached

If your Mac is asleep, Rufi isn't running there, or Tailscale is off on either, the iPhone says **Can't Reach Your Mac** with **Try Again**. If the Mac becomes unreachable while Rufi is open, a line says **Can't reach your Mac. Checking again every few seconds.** and the page comes back by itself when it can. What you were typing stays.

If the iPhone says to update Rufi on your iPhone or on your Mac so they match, they were built for different versions: update the older one.

## Unpair

On the Mac: click **Unpair** on its line, then **Unpair** again. From then on it can't open Rufi, and anything it has open ends at once. What it sent stays on your Mac. If you lose your phone, unpair it here. When it was that person's last iPhone, their reminders ring on the Mac. The next time Rufi on that iPhone reaches the Mac, it says it was unpaired, with **Pair Again**.

On the iPhone: in **This iPhone**, tap **Unpair This iPhone**, then confirm. The iPhone forgets its key and the Mac stops letting it in.

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
