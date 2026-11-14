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

After pairing, the iPhone offers **Lock Rufi**: Rufi then asks for Face ID, or your iPhone's passcode, when you open it and after more than a minute away. While Rufi isn't on screen, the app switcher shows a blank page instead of your record. Turn it on or off in **This iPhone** (your initials, at the bottom of the sidebar). It needs a passcode on the iPhone: without one, the switch is off and says so.

iOS can also lock any app (touch and hold its icon, then **Require Face ID**). If you use that for Rufi, turn **Lock Rufi** off, so you aren't asked twice.

## On the iPhone

The sidebar button at the top left shows the **sidebar**, or swipe right on the page: the page slides aside and fades, with the sidebar under it. On a page opened on top, the same swipe is Back. On a table or a chart that scrolls sideways, a swipe right scrolls it back first. The sidebar has the Mac's places in the Mac's order: **Overview**, your health record's pages with how many each has (empty ones grey), **Follow-ups**, **Documents** and **Help**. The place you are in is in bold. Tap one to go there; tap the edge of the page beside the sidebar, or swipe left, to go back to the page. At its bottom, **Chat** opens your chat with Rufi, and your initials open **This iPhone**. Settings is on the Mac only.

The chat, **Overview**, your health record's pages, **Follow-ups** and **Documents** are drawn by the iPhone itself, from your record on the Mac as it is now, and so are a test's page, a visit's page and a document; a visit brief still comes from Rufi on your Mac. Either way, what you do on the phone is done on the Mac. On a record page, tap a row to open it on top: what it says, its **Sources** (a document's page opens that document) and its **History**, every save to it. On **Lab results**, a test opens its page: each of its values, newest first, where each came from, then the test's own sources and history; a value opens as a row. **Measurements** come by the day they were taken. A medicine opened shows its directions, times, days, until when and its reminders, then its **Doses** in the last 14 days. A visit opens its page: the doctor's words, what was saved from it, its sources and history. A follow-up opened also says what it is about, which opens that record. **Documents** lists each document with its status, newest first; **Kind** (top right) shows one kind. Touch and hold a document for **Retry**, **View reading** and **Ask Rufi**. A document opens its page: what it is, **View original**, **View reading**, its pages as Rufi AI saw them (the arrows go from page to page), what the reader read from each page, what waits to be saved, and **Delete**, which first shows what goes and what stays (see [Delete a document](documents.md#delete-a-document)). Tap an item to see its page. **Save in chat**, **Retry**, and **Ask Rufi** on a document or an item put it in the chat's box, and the page stays: the box's line at the bottom of the page shows it, and lights up. Above it shows what the box says, such as why a message came back to it, or **Not saved** with **Retry**. Touch and hold a row of a record page, a test or a value on **Lab results**, a follow-up, or a **Needs you** line on **Overview** for **Ask Rufi** too. Collect what you want to ask about while you read, then tap the line to write and send; nothing happens until you send. To fix an item, ask Rufi about it. The phone shows no charts: each value is a row. Pull down on a page the iPhone draws to read it again. A link to another page opens it on top, with its own name at the top (for example **HbA1c**) and **Back** (or a swipe from the left edge) to return; a link in a reply opens the result over the chat, with Back to the chat. In the chat over a page too, a link opens on top, even one to a row of that page; Back shows the page with the chat open again. A link to one of the sidebar's places goes to that place. Web links open in Safari.

**The chat** shows your messages, Rufi AI's replies and Rufi's own lines, as the Mac's chat does, and follows a reply as it comes while you are at its end. A reply shows while it is written as chosen on the Mac in Settings › Chat › **While Rufi writes**: paragraph by paragraph, word by word, or whole once done (see [While Rufi writes](chat.md#while-rufi-writes)). A visual in a reply is drawn in its place once it is whole; word by word, it waits as an empty box until then. If the iPhone can't show one, it says **Can't show this visual**: tap **Reload**. Tap a button in a visual to answer, as on the Mac (see [How a reply looks](chat.md#how-a-reply-looks)): its message goes into the chat as yours, and your half-typed words stay in the box. While your Mac can't be reached, it waits on the iPhone with your other messages. A question card from Rufi AI shows as on the Mac (see [A question card](chat.md#a-question-card)): tap an answer, or **Reply** to answer in your own words. While your Mac can't be reached, your answer waits on the iPhone and the card says **Pending**; if Rufi refuses it, its words and the card's quote go back into the box. Tap the quote at the top of your answer to go back to its card. Rufi AI's thinking and steps fold under **Activity**, as Settings chose on the Mac; tap it to open or close it, tap a thinking line to read all of it, and tap a step to see what the AI did. What waits to go to the AI shows above the box, in the order it goes, as on the Mac (see [Waiting messages](chat.md#waiting-messages)). While a reply runs, **Steer** (two arrows that meet) sends a waiting message into it; the pencil edits it (while it saves, the words wait as they are; if Rufi can't keep the change, the editor stays open with your words and says why) and the X removes it; touch and hold one, then drag it, to move it. A held message says why under it and goes only when you tap **Send** (the arrow); when the AI's thread didn't open, **New thread** starts a new one. Rufi AI's agents at work show above the box too, each with how long it has run: tap one to see its own Activity, with **Stop** while it works (see [When the AI starts agents of its own](chat.md#when-the-ai-starts-agents-of-its-own)). An agent's message to Rufi AI shows in the chat under its name; tap the name for the same, and a helper's line in an Activity opens it too. Scroll up for earlier messages. A picture the AI made shows on the Mac only.

**The chat box.** On any other page, the box is one line, **Ask or tell Rufi about Asha…**: tap it to open the chat over the page. Swipe down on its top to go back to the page as you left it; **Open as Page** (the arrows at its top right) opens **Chat with Rufi**. The chat has the box at the bottom. At rest it is one line: your words and **Send**. Tap it to type: it opens with the paperclip, the model and effort, how much of the chat's memory is used, and **Send**. Return adds a new line; **Send** sends. What you type is kept as the chat's draft on your Mac a moment after you stop. Words not yet sent, or a chip, keep it open; empty, it goes back to one line when you put the keyboard away (swipe down on the chat). While a reply runs, **Send** becomes **Stop**, or **Steer** or **Queue** once you type, as Settings chose. Under the box, "AI can make mistakes. Check important health decisions with your doctor."; it hides while you type. This iPhone, Reminders and Help have no box. On a document, **View original** shows the file as it came in iOS's own viewer, every photo of it too, with its share button; Rufi deletes its copy when you close it. On a visit brief, **View PDF** shows the brief as a PDF in that viewer, with its share button (see [Visit brief](visit-brief.md#view-a-brief-as-a-pdf)).

To add a document, tap the paperclip in the chat, or **Add** (+) on Documents: **Photos**, **Files** or **Camera**. Two or more photos ask whether they are one document (a report photographed page by page) or one each. **Camera** is iOS's document camera: it finds the page's edges and straightens it; scan each page, then tap **Save**, and the pages go to your Mac together as one document. Each document's chip appears in the box (from Documents, the chat opens with it); Rufi reads it when you send, and if you go to another place meanwhile, the chip is in the box when you come back. If Rufi can't add them, it says why in one line and keeps your words. If one photo or file you chose can't be read, Rufi adds none of them, so part of a report never goes in: choose them again.

Text follows the iPhone's Text Size (Settings › Accessibility › Display & Text Size), and Rufi is light or dark as the iPhone is, in the colour theme chosen on the Mac (Settings › Appearance there); the sidebar and This iPhone take it too. To keep Rufi light or dark on this iPhone whatever the iPhone is set to, choose **Light** or **Dark** under **Appearance** in **This iPhone**; **System** follows the iPhone again. A theme changed on the Mac shows the next time Rufi opens on the iPhone. Rufi's own text size and the Mac's light or dark setting are for the Mac.

Settings, sign-in and backups are on the Mac only.

## Medicine reminders on the iPhone

When that person's reminders ring on the **iPhone** or **Both**, Rufi on the iPhone rings them itself, at each medicine's times, as Rufi's own notices. They aren't Apple's Medications reminders.

- **One notice per time**, with every medicine due then. Rufi's notices stack together in Notification Center.
- **What it says** is the person's choice under **Reminders** (the bell at the top right of Medicines, or on the Mac's Medicines page): **Just the time** ("Medicines at 21:00"), **How many** ("2 medicines at 21:00"), or **Which ones** ("21:00 · 2 medicines", then each name, strength and amount). On the Lock Screen, Which ones shows names unless the iPhone's Settings › Notifications › Show Previews is **When Unlocked**; then it shows "Medicine reminder" until you unlock.
- **Where reminders ring:** **iPhone**, **Mac** or **Both**, in the same place. With **Mac**, the iPhone has no medicine notices.
- **Times are where you are.** A medicine at 08:00 rings at 08:00 on the iPhone's clock, also when you travel.
- They are **Time Sensitive**, so a Focus doesn't hold them back. To change that, open Settings › Notifications › Rufi on the iPhone (Rufi Dev for a testing build).
- Tap a notice to open Rufi at **Medicines**, after Lock Rufi.

### Log a dose on Today

On **Medicines**, **Today** lists each dose today, on your Mac's day, with how to take it. **Taken** or **Skipped** logs that dose, as on the Mac's Today; a logged dose shows, for example, **Taken 08:12 · iPhone**, with **Undo** to clear it. A log goes to your Mac the same way as one from a reminder: if the Mac can't be reached, it waits on the iPhone, marked **Pending** on Today and listed in **This iPhone**, and goes the next time Rufi reaches the Mac. It is never counted twice.

### Log a dose from a reminder

Touch and hold a reminder, then tap **Taken** or **Skipped**. It needs the iPhone unlocked, not Lock Rufi, and works with Rufi closed. A paired Apple Watch shows the same.

- **Taken** or **Skipped** logs every medicine on that reminder. To log only one, tap the reminder: Rufi opens at **Medicines**, where **Today** logs each on its own.
- The log goes to your Mac at once and shows on its **Today** as, for example, **Taken 21:02 · iPhone**. If the Mac can't be reached, the iPhone keeps it and sends it the next time Rufi reaches the Mac (when you open it, or in the background). It is never counted twice, even when it is sent again.
- To change a log, use **Undo** on Today.

**Not on your Mac yet.** Doses you logged that your Mac doesn't have yet are listed in **This iPhone**. Swipe one left to **Discard** it: it is never sent. If your Mac refuses one, it says so there and isn't sent again. They stay if the iPhone is unpaired: they are sent only when you pair again for the same person with Rufi on the same Mac, and never to another pairing. Until then they show on the unpaired screen, and Lock Rufi stays on while any wait. Deleting the app deletes them.

**Set until.** The iPhone gets its reminders from your Mac for the next week, and the next time after it (so a medicine you take once a month still rings), and keeps them when it can't reach the Mac. **This iPhone** shows until when they are set, for example "Set until Thu 5 Nov, 21:00". The iPhone gets them again each time you open Rufi, when you leave it, and now and then in the background when iOS allows. If you don't open Rufi for a week, a last notice, **Open Rufi to keep your reminders coming**, rings a minute after the last one set.

After you change a medicine's times or reminders on the Mac, open Rufi on the iPhone, so it rings the new ones: until then it rings what it had. With Rufi open on the iPhone, it follows at once. A dose you logged, on the iPhone or the Mac, rings no more, and its notice leaves Notification Center the next time the iPhone gets its reminders, as do notices for a medicine you stopped or retimed, and ones older than yesterday.

If nothing rings, check **This iPhone**: **Notifications** says whether iOS lets Rufi ring, with a way to turn them on.

## Apple Health

In **This iPhone** › **Apple Health**, connect Apple Health, see your latest resting heart rate and heart rate, and tap **Sync for Asha** (with the paired person's name) to send your heart data to Rufi on your Mac. See [Device data](device-data.md#apple-health-from-your-iphone) for how it works and what each line means.

## What the iPhone keeps

- Its key, in the iPhone's keychain, on this iPhone only.
- Which Mac it paired with and whose record it opens, whether Lock Rufi is on, and its Appearance (System, Light or Dark).
- Its medicine reminders for the next week, as iOS notices: the times and the medicines, whatever a notice shows.
- Doses you logged that aren't on your Mac yet: each medicine's name and strength, the dose's time, taken or skipped, and which Mac and person it is for. They aren't in the iPhone's backups.
- Messages you sent, until your Mac has them (a moment, or until Rufi can be reached again): their words and what you added to them. They aren't in the iPhone's backups, and unpairing removes them.
- For Apple Health: where each kind of heart data was sent up to (Apple's bookmark, not the values), and when the last sync was and how many readings it sent.
- Rufi's own files (the scripts and styles its pages are drawn with, none of your record), so it opens without fetching them from your Mac again, and the colour theme's colours.

Apart from those messages, nothing of your record, chat, documents or heart data is kept by Rufi on the iPhone (your heart data stays in Apple Health, where it was): pages are shown while Rufi is open and gone when it closes, and an original you view is a temporary copy, deleted when you close it (or the next time Rufi starts, if it was closed while showing one); photos, files and scans you add go straight to your Mac without being saved on the iPhone. Deleting the app deletes all of this; to use Rufi on that iPhone again, pair it again.

## Rufi and Rufi Dev

Testing builds of the iPhone app are named **Rufi Dev**. Rufi and Rufi Dev are separate apps and can both be on one iPhone. Each one pairs on its own, with its own line in Settings › iPhone, and keeps what it keeps on its own: its key, Lock Rufi, reminders, Apple Health bookmarks and doses not on your Mac yet. Nothing moves from one to the other. When both are paired for the same person, both ring that person's reminders; unpair the one you don't use. Where this page says Rufi on the iPhone, it means whichever of the two you opened, also in the iPhone's own Settings.

## When your Mac can't be reached

If your Mac is asleep or off, Rufi isn't running there, Tailscale is off on either, or the iPhone has no network, a small pill just above the chat box says **Can't reach Rufi**, with a spinner: Rufi on the iPhone asks again by itself, at once when you open it or come back to it, then after a few seconds, then every 30 seconds while it is on screen. Tap it to ask at once. When Rufi answers, it says **Connected** for a moment and goes, and the page reads again.

Meanwhile, everything that doesn't need your Mac works: the sidebar, **This iPhone**, and the reminders, which keep ringing. The page you were reading stays as it was. A page the iPhone draws shows what it last read since Rufi opened, also when you go back to it. A page that hasn't loaded shows only the dog, resting.

The chat box stays too, with your words and **Send**; the paperclip, the model and the context used come back with Rufi. A message you send meanwhile shows at the end of the chat, marked **Pending**, and goes by itself when Rufi answers, in the order you sent them, as if you had sent them then. If Rufi refuses one (for example, too long), it goes back into the box with Rufi's reason under it: change it and send it again, or clear it. Words you typed and didn't send stay in the box, and take the place of the draft on your Mac when it is back.

If the iPhone says to update Rufi on your iPhone or on your Mac so they match, they were built for different versions: update the older one.

## Unpair

On the Mac: click **Unpair** on its line, then **Unpair** again. From then on it can't open Rufi, and anything it has open ends at once. What it sent stays on your Mac. If you lose your phone, unpair it here. When it was that person's last iPhone, their reminders ring on the Mac. Reminders already on the iPhone can still ring until it next reaches your Mac, at most a week. The next time Rufi on that iPhone reaches the Mac, it removes its reminders and says it was unpaired, with **Pair Again**.

On the iPhone: in **This iPhone**, tap **Unpair This iPhone**, then confirm. A sync running stops first. The iPhone forgets its key and its Apple Health bookmarks, removes its reminders and any messages still waiting, and the Mac stops letting it in. Doses not on your Mac yet stay (see [Log a dose from a reminder](#log-a-dose-from-a-reminder)).

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
