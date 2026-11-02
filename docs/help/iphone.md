# iPhone

Rufi on your iPhone opens your own record from Rufi on your Mac, through Tailscale. You pair it once in [Settings › iPhone](rufi:/settings/iphone). This page says what pairing needs, how to pair and unpair, and what to do when a step fails.

Rufi's iPhone app isn't ready yet. Pairing works on the Mac today, so the app can use it when it comes.

## What pairing needs

- **Tailscale** on your Mac and your iPhone, signed in to the same tailnet. Rufi reaches your Mac only through it: nothing else on the internet or your network can reach this door.
- **HTTPS turned on** for your tailnet: in the Tailscale admin console, on the DNS page.
- **Your Mac awake, with Rufi running**, whenever you use Rufi on the iPhone.

## Pair an iPhone

1. Open [Settings › iPhone](rufi:/settings/iphone) and click **Pair an iPhone**.
2. With more than one person in this data folder, choose whose record the iPhone opens. Pair a phone for your own record only for now: Rufi AI on the phone can read every person's files in this folder.
3. Rufi sets up Tailscale for it and checks that it can reach itself through Tailscale. Then it shows a QR code and **Copy link**.
4. Scan the code with Rufi on your iPhone, or paste the link there. The code works once, for 10 minutes. When the phone has paired, Settings says **Paired: Asha's iPhone, for Asha**.

**Close** before a phone pairs ends the code. Each paired iPhone has its own line: its name, whose record, when it paired, and when Rufi last saw it.

A paired iPhone opens only that person's record, for good. To open another person's record, pair again for them.

Pairing leaves that person's medicine reminders ringing on the Mac. Under **Reminders** on the Medicines page you can choose **iPhone** or **Both** (see [Reminders](record.md#reminders)); the iPhone rings once Rufi's iPhone app is ready, so until then keep **Mac** or **Both** to be reminded.

## Unpair

Click **Unpair** on its line, then **Unpair** again. From then on it can't open Rufi. What it sent stays on your Mac. If you lose your phone, unpair it here. When it was that person's last iPhone, their reminders ring on the Mac.

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
