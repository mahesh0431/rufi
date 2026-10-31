# Talking to Rufi

The chat is where you talk with Rufi's AI about your health record. You have one chat with Rufi, and you can see it in three sizes: the chat bar, the chat panel and the chat page. Rufi keeps the whole chat, and what you typed but didn't send. To talk about something new, just say so.

## The chat bar

The chat bar is the box at the bottom right of the pages where you read your health: Overview, each page of your health record, Follow-ups, Documents, a document's page and a visit brief. It says "Ask or tell Rufi about" and your name, and shows the model and effort that answer, such as "GPT-6-Astra Medium". It is your chat, the same as the panel and the page, and the same in every browser tab. These pages leave room at their bottom for the bar, so it never covers a row or a button. Help and Settings have no chat bar: to talk to Rufi from there, click **Chat with Rufi** in the sidebar. The chat page has its own box.

The bar is always the same size: one line. When you add something to your message with **Ask Rufi** (see [Adding to a message](#adding-to-a-message)), the bar shows the first one's name and how many more, such as "CRP <5 mg/L · 12 Aug 2026 +2", and lights up for a moment. After that, it shows the start of what you typed. When Rufi has something to tell you, such as why it couldn't add something, the bar shows that for the moment, in grey. Click the bar to see it all in the panel, and to write your message.

Under the box, in the panel and on the chat page, "AI can make mistakes. Check important health decisions with your doctor." reminds you to check what the AI says. To see how the AI is signed in, and your ChatGPT plan's usage, open **Settings** › **Sign-in** (see [Signing in](signing-in.md#your-sign-in-in-settings)).

## The chat panel

Click the bar, or press ⌘J, to open the chat panel over the page. The panel is always the same size, and the page stays as it is behind it. The cursor is in the box, ready for typing.

A thin bar at the top of the panel has:

- **Minimise** (–), which makes the panel the chat bar again. Esc does the same, and puts you back where you were. When a menu is open, Esc closes the menu first.
- **Chat with Rufi**, the chat's name.
- **Open as page** (the arrows), which shows the chat as a page.

Press ⌘J again, or click anywhere outside the panel, to close it. What you typed stays in the box. Going to another page also closes it.

## The chat page

Click **Chat with Rufi** in the sidebar, on any page, to open your chat as a page. The page shows the same chat as the panel, with the same box. In a small window, the chat opens as a page instead of the panel.

A new chat, with nothing in it yet, shows Rufi saying hello over the box.

## Reading back

The chat opens at its latest messages. Scroll up to see older ones: Rufi loads them as you go, and what you read stays where it is on the screen. If Rufi can't load them, the chat says so: click **Retry**.

A line between days says which day the messages under it are from: "Today", "Yesterday", then the day, such as "Thu 8 Oct", with the year when it isn't this year. The days are in your Mac's time zone.

## Sending a message

Type in the box and press Enter, or click the send button. Shift-Enter starts a new line. You can send files with no words: the send button works with at least one chip too.

When you send, the box says "Sending…" for a moment, and you can't change it; then it empties. Rufi sends the text in this box, also when another tab saved other text just before. Then the message goes to the AI: at once when nothing runs, or, while a reply runs, into that reply or after it, as you choose (see [While the AI replies](#while-the-ai-replies)). It shows in the chat at once: after the chat's last message, marked waiting, until the AI takes it, and then in its place in the chat. A message with new files takes its place when Rufi starts to read them (see [Documents](documents.md#while-a-document-is-read)).

If you aren't signed in when you send, nothing goes to the AI and nothing waits: your text stays in the box, which says "You're signed out. Sign in with ChatGPT to chat." Click **Sign in** (see [Signing in](signing-in.md)), then send again. A message that already waited when the sign-in went away keeps waiting, and so does one you send while the AI replies if the sign-in goes away just as it is handed over. Signing in alone doesn't send it: it goes the next time Rufi gives the AI something, with your next message or with one of Rufi's notes (see [Rufi's lines](#rufis-lines)). A reply has no time limit. If your sign-in ends while the AI replies, the reply ends there, with the error as the service reported it.

If Rufi can't be reached when you send, your text stays in the box with the reason, also when you leave the chat or reload the page in this tab. Press Enter again: if Rufi did take the first one, it knows this is the same message and doesn't take it twice.

A message counts as sent when Rufi hands it to the AI. Rufi never sends a message again by itself. If Rufi couldn't hand it over, the message stays among the waiting messages, marked **Failed** with the error as it came, and you choose: **Send** it again, **Edit** it or **Remove** it (see [Waiting messages](#waiting-messages)).

A message can have up to 10,000 characters. When the box has more, it says so, and Rufi doesn't keep or send the text until you make it shorter.

## Adding to a message

You can add your records and documents to a message, so the AI knows exactly what you mean by "this" or "these". Each one shows in the box as a chip, above your text: a record such as a result with its value and date, or a document with its name. Point at a chip to see what it is.

**Ask Rufi** is Rufi's face with a blue +, at the end of a row. It shows when you point at the row, or when the row has the keyboard focus; on a touch screen it is always there. Point at it and a small label says "Ask Rufi about this".

- **A record:** on its page (see [Your health record](record.md)), click **Ask Rufi** on its row.
- **A report:** on Lab results, click **Ask Rufi** in a report's heading. Its results, with any measurements it printed, go in as one chip, such as "Sunrise Labs · 12 Aug 2026 · 3 results", and the AI reads exactly that report's results. Lab results you typed in the chat, and days of measurements, have no such heading button.
- **A follow-up or a document that needs you:** on Overview, click **Ask Rufi** on its line in **Needs you**.
- **A document:** on the Documents page, click **Ask Rufi** on its row.
- **A draft result:** on a document's page, click **Ask Rufi** on its row (see [Documents](documents.md#add-some-results-to-the-chat)).
- **A new file:** click the paperclip next to the box, or drop files on the chat panel or the chat page. The Documents page's **Add…**, and a drop on that page, do the same: they open the chat and put the files in its box. Each file is added at once (see [Documents](documents.md#add-documents)) and its chip goes in the box, but nothing is read until you send: your files and your words go as one message. A file you already added gives the chip of the document you have, and the box says so. The chat stays open after you add files.

**Ask Rufi** never takes you away from the page, and doesn't open the panel: collect what you want to ask about while you read, then click the bar to write and send. When the panel is open, **Ask Rufi** adds to its box, and the panel stays open. If Rufi can't add it at that moment, the bar says why and what to do: the box is still loading, a message is being sent, or your last message may not have reached Rufi (send it again or change it first).

A chip shows only a name and what it is; it has no reading state. A chip marked **· read again** is a document whose unreadable pages Rufi reads again when you send (see [Retry](documents.md#retry)). While a file you added is on its way, the box says "Adding" and its name until its chip comes.

To take a chip out, click its **×**. This changes nothing in your health record. A file that was never sent is removed from Rufi, with its pages; a document you already sent only leaves the box. The chips are kept with what you typed, also when you reload or Rufi starts again, and they go with the message: your message in the chat shows them too.

Rufi checks each chip: it must be in the health record of the person whose chat it is. If it isn't, the box says "Something added to this message isn't in this person's record. Take it out of the message and add it again." A chip of a document you deleted says "A document added to this message was deleted. Take it out of the message."

When you delete a document (see [Documents](documents.md#delete-a-document)), its chips in messages you sent, and the chips of its draft results, keep their names and say **document deleted**. They open nothing. A chip of it in a message that waits to go says the same, and the AI is told that the document was deleted. The AI reads exactly what each chip pointed to when you sent the message. A message can have up to 100 chips.

## What you see

- **Your messages**, on the right, with the chips you added to them.
- **The AI's replies**, which appear as the AI writes them. Replies can have lists and tables, and the pictures, pages and diagrams the AI makes (see [Pictures, pages and diagrams](#pictures-pages-and-diagrams)). Links to web pages open in your browser, outside Rufi. A reply never shows a picture from the internet.
- **Activity**, under an answer: what the AI did for that reply, folded into one line, such as "Activity · 12 steps · 1 failed · 1m 36s". Click it to open it. While the AI works, it is open, and you can read along. See [Activity](#activity).
- **Based on**, beside Activity once the reply has ended. It opens where the answer comes from, in the AI's own words. See [Where an answer comes from](#where-an-answer-comes-from).
- **Receipts**, with a tick, each time the AI saved something to your health record: "Saved", then one line for each change. A save from a document starts with a summary, such as "Saved 42 results from Sunrise Labs August.pdf · 40 new · 1 more source · 1 correction"; when the list is long, click **Show what was saved** to see it. Rufi writes them. See [Changing your health record](#changing-your-health-record).
- **A visit brief's line**, with a page sign and **Open**, when the AI made a brief for you. Rufi writes it. See [Visit brief](visit-brief.md).
- **Rufi's lines**, with a bell and "Rufi" above them, when something happened outside the chat. Rufi writes them, never the AI, and they are never your words. See [Rufi's lines](#rufis-lines).
- **How a reply ended**, when it didn't finish: for example "Stopped.". When the AI service stopped the reply with an error, the line shows the error as the service reported it, such as "exceeded retry limit, last status: 429 Too Many Requests". Rufi doesn't put it in other words. When the service gave no words, the line says "This reply didn't finish.", and for your ChatGPT plan's usage limit, the time it resets.
- **Quiet lines** about the AI's memory of the chat: "Compacting chat history…" while the AI compacts it, "Chat history compacted" once it has, and "New thread started" where the AI started with a new memory of the chat. See [The AI's memory of the chat](#the-ais-memory-of-the-chat).

## Activity

Activity shows what the AI did for a reply, as the AI's agent reported it. Rufi doesn't put it in other words.

- **The AI's notes**, in full, such as "I'll check your fasting glucose and HbA1c first." The AI writes these while it works. They are part of Activity, not answers.
- **The AI's thinking**, as the headings the AI service sends, such as "Comparing the reports", in their place among the steps. When a heading has more under it, click it to read the AI's summary. When the AI service sends nothing, there is no line.
- **The steps**, each as it was reported: a command the AI ran, with its exit code; one of Rufi's tools, such as `rufi.get_records`, with what the AI asked for; the files the AI changed; a web search. A long step is cut in the middle, so the start and the file name show. A tick means it was done. Other signs mean it is running, it failed, or it stopped.

Click a step to open everything the agent reported about it: for a command, the whole command, its folder, its exit code, how long it took and what it printed; for a tool, what the AI sent and what came back. Long output shows 12 lines, then **Show all**. A step from before Rufi kept these says "Rufi kept no details for this step."

While the AI works, Activity is open, starts with Rufi thinking, says "Activity · working" and how many steps, and grows as the AI goes. When the answer comes, it folds into one line under the answer: how many steps, how many failed or stopped, and how long the reply took. Click the line to fold or open it at any time, also while the AI works. When you fold it while the AI works, its line says "Working", how many steps, and the newest step.

Choose how Activity opens in **Settings** › **Activity**:

- **Show while working** (the start): open while the AI works, folded when the answer comes.
- **Always show**: open while the AI works, and still open after the answer.
- **Always hide**: folded. While the AI works, one line says "Working", how many steps, and the newest step.

In each one, you can still fold or open a reply's Activity yourself. That holds on this page until the reply ends; after a reload, Activity follows the setting again. Another tab or window shows the same steps and folds by itself.

A reply that has no steps, such as an answer to "thanks", has no Activity line. In replies from before this version of Rufi, the AI's notes show as replies, and each step keeps the words Rufi gave it then. If the AI's working state is lost, replies show without their Activity (see [Your data and the AI](your-data-and-the-ai.md#your-chat)).

## Pictures, pages and diagrams

The AI chooses how to show its work: in words, as a table, as a picture or as a page. When the AI makes something in its folder to show you (see [What the AI can do in its folder](your-data-and-the-ai.md#what-the-ai-can-do-in-its-folder)), the reply shows it:

- **A picture**, such as a chart that the AI's program drew, shows in the reply at its own size, up to the reply's width, with the AI's caption under it. Click it to see it full size; press Esc or click again to go back. Rufi shows PNG, JPEG, GIF and WebP pictures.
- **A picture the AI generated** shows the same way, with "Made by the AI" under it. When the reply also shows that picture, it shows once.
- **A page**, an HTML file that the AI made, such as a chart or a page of your results to show your doctor, shows in the reply at the reply's width and a fixed height, with its title under it. When the page is taller, it scrolls inside its frame. **Open** shows the page large over the chat. **Close** or Esc goes back to the chat where you were, also after you click inside the page. Opening its address by itself says "Open this page from the chat in Rufi."
- **A diagram** that the AI explains something with shows as a drawing, in Rufi's colours. While the reply is written, and when the diagram can't be drawn, it shows as its text.

Rufi shows files only from the AI's folder and from the folder where the AI keeps the pictures it generates. A link to any other file shows as its words.

A page runs in a locked frame:

- **It is self-contained.** It shows only what is in its own file. It can't load anything from the internet or send anything, so it shows the same with no connection, and your health data in it stays on your Mac. The AI can use the internet while it makes a page, and puts in the file what the page needs.
- **It can't reach Rufi.** Its scripts run (for example tabs, or a chart that shows a value when you point at it), but they can't read Rufi's pages, your record or anything Rufi answers, and they can't change anything.

A reply shows the file as it is now, not as it was when the AI wrote the reply. If the AI changes the file later, an older reply shows the new version. If the file is no longer there, the reply keeps its title and says "This file is no longer in the AI's folder."

## Asking about your health record

Ask the AI about your health record in your own words, for example "What was my last HbA1c?", "How many times did I have a headache this year?" or "How has my HbA1c changed since I started creatine?". The AI reads your Overview. For anything more, such as earlier results, counts or dates, it reads one kind of record, such as your lab results, your measurements or your symptoms, all of them or between two dates. The AI does the counting and the comparing itself.

What the AI's reads can do:

- **Only this person's record.** A read gets only the records of the person whose chat it is. It can't read another person's record, the chat or Rufi's settings. Rufi chooses the person, not the AI.
- **Only read.** A read can't change anything.
- **Removed records too.** Records you removed, and the earlier versions of amended results, are in a read too, marked as removed or replaced.
- **Limits.** One read gives the AI only so many records, newest first. When there are more, Rufi tells the AI where the read stopped, and the AI reads on from there, or says in its answer what the missing records mean. A read that failed gives the AI an error, never an empty list.
- **Exactly the ones you added.** For the results you added to a message, the AI reads those records and no others.
- **Where each one came from.** Each record comes with its sources: your message, or a document and its page.

If your health record changes while the AI answers, for example because the AI saved something in the same reply, two of its reads can see the record before and after the change. Rufi keeps what each read got back with the chat.

## Where an answer comes from

Under an answer, once the reply has ended, **Based on** sits beside Activity, with an info sign. Click it to open the AI's own words on where the answer comes from: your health record, read in this reply or earlier in the chat, the web, or general knowledge. They also say how the AI got the answer, for example which results it compared. Click outside, press Esc or click **✕** to close it.

To see what the AI read, open [Activity](#activity): each read of your health record is a step there, such as `rufi.get_records`, with what the AI asked for and what came back. If Based on and Activity don't agree, ask the AI.

Anything that changes what an answer means, such as only two readings or a missing month, is in the answer itself, not only under Based on.

Small talk, such as "thanks", has no Based on. While a reply runs, Based on isn't there yet. If you stop a reply, or Rufi closes during it, what the AI wrote so far stays, without Based on.

The AI writes these words at the end of its reply, and Rufi shows them under Based on, not in the answer. If the AI forgets them, the answer has no Based on.

## Changing your health record

You change your health record by telling the AI in the chat. Nothing changes until you say yes.

1. Tell the AI, for example "I stopped creatine because of a stomach upset".
2. The AI reads your health record, then says what it will save and asks you. Nothing is saved yet.
3. Say yes to save it, in your own words and in any language: "yes" or "ok, do it" is enough. If you say no, ask a question, or say "yes, but explain first", the AI saves nothing.
4. The chat shows a receipt with a tick: "Saved", then one line for each change, with the record's name in bold and each changed detail as old → new. For example:

   > **Saved**
   >
   > - Changed medicine use **Creatine 5 g**: status _current_ → _stopped_
   > - Added symptom **Stomach upset**

   When a detail is long, its line shows the part around the change. Rufi writes the receipt itself, from what it saved, not from the AI's words. If the receipt is different from what the AI told you, trust the receipt and tell the AI.

The AI can save medicines you take, visits to a doctor (with what the doctor wrote or said), symptoms, conditions, allergies, lab results, measurements such as your weight or blood pressure, procedures and immunisations, "no known allergies", and follow-ups.

What Rufi does when it saves:

- **Only what you said.** A detail you didn't give stays unknown. A date is saved only when you gave one, at the precision you gave it: "since 2019" stays a year. Rufi keeps the words the date came from, such as "last Monday", and the AI counts them from when you sent the message, not from when you said yes. A result always needs a date: when a report has none, the AI asks you for one, and a rough date is fine (see [Save results to your health record](documents.md#save-results-to-your-health-record)).
- **Where it came from.** The source of a change is your message the change came from: the one where you told the AI the facts, not your "yes". A record saved from a visit has the visit as its source, and the visit has its paper's page. A record's **Sources** show them (see [Your health record](record.md)).
- **Dates to come.** A date after your message, such as a planned visit or a recheck in December, is saved as you gave it. So is a date that should already have happened but is later than your message, such as when a symptom started: the AI mentions it after saving, in case it is a slip such as a wrong year, and you can tell it to change it.
- **All or nothing.** When one part can't be saved, nothing is saved, and the AI tells you why.
- **Nothing is deleted.** A record you remove leaves your current health record, and Rufi keeps its history.
- **One medicine, one use.** When you take a medicine in two ways, such as a morning and a night dose, stopping one doesn't stop the other.
- **A visit's medicines become yours only when you say you take them.** The AI asks "Are you taking these?" before it saves any of them as a medicine you take. One you already have gets the visit as one more source, and its details stay. When the doctor changed a dose, the old one is stopped and the new one added, so your history shows both.
- **A lab result or a measurement.** The AI says which each new result is, and asks when it isn't sure. To move a result to the other page, say so, for example "this weight is a measurement": its value, date and sources stay, and the receipt shows the change (see [Lab results and Measurements](record.md#lab-results-and-measurements)).
- **"No known allergies" has a date.** It can't stay in your health record beside an allergy that is active or whose status is unknown. When you tell the AI about such an allergy, it asks you to remove "no known allergies" in the same save.

To see your health record, open Overview or one of its pages (see [Your health record](record.md)). To change a record from there, click **Ask Rufi** on its row.

### Saving a document's results

To save the results Rufi read from a document, add the document to a message and say "save it", or "save these" with the results you chose. The AI checks the results with you first, then saves them. See [Documents](documents.md#save-results-to-your-health-record).

### Undo

Say "undo that". The AI reads the save and your health record as it is now. It tells you what it will change back, and anything that changed after that save, and asks you. Say yes, and the AI saves the reverse, with its own receipt: a removed record is put back ("Put back result …"). The first save stays in the history. When the save added a document page or a visit as one more source of a record, the undo takes only that source off: the record stays. Undoing a visit removes the visit and what was added from it, and sets back a medicine it changed; when a medicine needs both, set back and its source taken off, you see two receipts.

### When a save and a stop meet

If you stop the reply while the AI saves, the save can still finish. Then its receipt shows in the chat, and the AI sees it the next time you write. Say "undo that" if you don't want it.

### When the AI starts agents of its own

For a task that can run on its own, the AI can start an agent of its own, a sub-agent. It gets only the task the AI gives it, never your chat, and works with the AI's tools or fewer, on the AI's model or another one you ticked in **Settings** › **Models**. Between a sub-agent's turns, the AI can move it to another of those models, never while it works. On another provider's model, the sub-agent starts a new conversation there, which has its last 10 turns. It can go on after the reply ends: what it saves shows in the chat with Rufi's receipt, also after the reply, with its title after **Saved**. It saves only what you said yes to. You don't see sub-agents on the screen yet.

When a sub-agent finishes, the AI hears it by itself. If the AI isn't replying then, it replies by itself, and a small line above that reply says which agent and why, such as "Reading report.pdf: done" or "Reading report.pdf asks a question". The AI tells you what it found, or asks you what it asks. While a sub-agent works, the AI may end its reply and say so: the sub-agent's result wakes it. The AI can also write to a sub-agent, for example to answer its question.

You can ask the AI to stop a sub-agent: just that one, or with every sub-agent it started. Its result goes to the AI, which says it stopped. When you ask the AI to stop everything, it stops every sub-agent and its own reply too. Then none of the stopped sub-agents' results wakes the AI, and your waiting messages don't go: each shows **Not sent · Stopped.**, for you to **Send**, edit or remove. What waited for the stopped sub-agents is held the same way: the AI can send it again when you ask.

## While the AI replies

While the AI replies, three buttons are where the send button was: **Steer** (two arrows that meet), **Queue** (a list with an arrow) and **Stop** (the square). The chat bar also shows a turning circle before its text, because Activity doesn't show there.

**What the AI does.** Activity shows the AI's notes, its thinking and its steps as they happen (see [Activity](#activity)). After a reload, or in another tab, it shows the same.

If you click Stop, what the AI did so far stays in Activity, and the folded line says how many steps stopped. If Rufi closed before the reply finished, its Activity shows no time, because Rufi doesn't know when the reply ended.

**Stop.** The stop button (the square) ends the reply now, in every size of the chat. What the AI wrote so far stays. Stop ends only the reply: your waiting messages go next, in order, and the sub-agents keep working (to stop them, ask the AI; see [When the AI starts agents of its own](#when-the-ai-starts-agents-of-its-own)). A message whose reply was still starting when you clicked Stop doesn't go: it waits as **Not sent · Stopped.**, for you to **Send**, edit or remove.

**When Rufi closes during a reply.** If you quit Rufi, or it stops suddenly, while the AI replies, the reply ends **Rufi closed before the reply finished.** When Rufi starts again, the AI carries on by itself in a new reply, before your waiting messages. Its sub-agents that were working carry on too. Rufi tells the AI and each sub-agent only that it stopped suddenly and that they can carry on. To end a reply for good, click Stop before you quit.

If Rufi closes again and again while they work, they stop carrying on: after 5 restarts in a row, the AI and its sub-agents stay stopped, and your waiting messages show **Not sent · Stopped after 5 restarts in a row.** They go when you click **Send**, or with the next message you send. Choose how many times in **Settings** › **After a restart**. With 0, the AI never carries on by itself: the reply stays stopped, and your waiting messages go as usual. The count starts again when a reply finishes, or when you send a message.

**Rufi's reader.** When your message brings files, your reply starts with Rufi's part: Rufi's reader copies the pages before the AI starts. Each file is a step in Activity, **Rufi's reader · thyrocare-aug.pdf**, with how far it is. Stop ends the reading too. The AI starts when all files are copied, and answers your message in the same reply (see [Documents](documents.md#while-a-document-is-read)). If the reading doesn't finish, the reply ends before the AI, with the reason and **Retry** (see [Documents](documents.md#when-a-reading-stops)).

**Sending while the AI replies.** You choose where a message goes:

- **Steer** puts it into the reply. The AI carries on with it in mind: it adds your message to what it is doing, and drops its work only if it has to. The message shows as waiting until the AI takes it, then in the reply. While the reply is still starting, or Rufi's reader is copying, it goes in once the AI runs.
- **Queue** keeps it until the reply ends. Then it goes in a reply of its own, in order with your other waiting messages.

Enter does what you chose in **Settings** › **Sending while Rufi replies**: **Steer** (the start) or **Queue**. The other button beside the box does the other. A message with new files always waits for a reply of its own, which reads its files first.

If the reply ends before your steer reaches it, your message goes in a following reply.

## Waiting messages

What waits shows in the chat, after its last message, in the order it goes: your messages as dashed bubbles, and Rufi's notes. It shows there also after a reload, a restart of Rufi, or a change of model. For each of your waiting messages you can:

- **Steer** it (two arrows that meet), while a reply runs: it goes into that reply now.
- **Edit** it (the pencil), then **Save**.
- **Move** it, to change the order: drag it up or down by its handle (the dots on its left). With the keyboard, go to the handle with Tab, press Space to pick the message up, the up and down arrows to move it, and Space to put it down. Esc puts it back where it was.
- **Remove** it (the X). It never goes to the AI.

You can also ask the AI to do these for you, for example "remove my question about the scan" or "send the held ones now". It sees what waits for it and for its sub-agents, and changes your messages when you ask. When it steers a held message, the message goes, as when you click **Send**.

The line above them says what happens next:

- **Waiting · these go in order after the reply**: they go by themselves.
- **Not sent · Rufi sends these only when you say**: some messages are held, as below.

A message with new files waits like any other, and gets a reply of its own, which reads its files first. Removing a waiting message doesn't remove its files: they stay sent, and the Documents page shows **Not read yet** with **Retry**. A message whose reply ended while Rufi read its files isn't listed here: it is in the chat already, and its reply's last line has **Retry** (see [Documents](documents.md#when-a-reading-stops)).

A held message says why under it, and goes only when you click **Send** (the paper plane); you can also edit or remove it:

- **Failed ·** and the error as it came, when Rufi couldn't hand the message to the AI, or the AI couldn't take it, for example when none of the models you ticked in **Settings** › **Models** is offered.
- **Not sent · Stopped.** You clicked Stop while its reply was still starting, so it didn't go.
- **Not sent · Stopped after 5 restarts in a row.** Rufi closed again and again while the AI worked, so the AI stopped carrying on by itself (see [While the AI replies](#while-the-ai-replies)). A new message from you sends it too, before your new one.
- **Not sent · From a backup: it waited when the backup was made.** After a restore, nothing from the past goes to the AI by itself.

When Rufi couldn't open the AI's memory of the chat (its thread), or start a new one, the failed message also has **New thread**. **Send** opens the same thread again, and the AI keeps its memory of the chat. **New thread** starts the AI with a new memory, and your chat and your health record stay as they are (see [The AI's memory of the chat](#the-ais-memory-of-the-chat)). While a reply runs, only **Send** shows (the message then goes after the reply); **New thread** shows again once the reply has ended. If Send meets an error again, the message waits again with both buttons. The message keeps waiting like this when you reload or Rufi starts again. When you click in two tabs, the first click counts, and the other tab shows what happened.

## Rufi's lines

Some things happen outside your chat. Rufi tells you with its own line in the chat. For example, after you delete a document, a line says **Deleted Sunrise Labs August.pdf**. When you chose **Delete file and results**, the chat opens, and the AI asks you about the document's results (see [Documents](documents.md#when-results-from-it-are-in-your-health-record)). Rufi writes these lines, not the AI, and they are never your words. Reading a file is not one of them: it is a step in your reply (see [While the AI replies](#while-the-ai-replies)). Lines from an earlier version, such as "Reading thyrocare-aug.pdf · 5 pages", stay in the chat as they were.

When the AI should know too, Rufi gives it a note:

- **When nothing runs**, the AI gets the note at once, in a short reply of its own. In that reply the AI explains or asks. It carries on with work you already asked for, and asks you first before any new change: every save rests on a message of yours.
- **When a reply runs**, the note waits in the chat among the waiting messages, as "Rufi's note", and goes in its turn after the reply, in a short reply of its own. Each note gets its own reply. **Remove** it if the AI doesn't need it.
- **When you're signed out**, it waits, and goes the next time Rufi gives the AI something after you sign in again.

## The model and effort

The model and effort that answer show in the box, next to the send button, in every size of the chat: for example "GPT-6-Astra Medium". Click them to open one menu with both. When you aren't signed in, the menu can't list the models: click **Sign in with ChatGPT** in it to sign in.

**The model.** Your chat has one model at a time. To change it, choose another in the menu: a tick shows the one that answers now. The menu shows the models you ticked in **Settings** › **Models** that your ChatGPT plan offers now: GPT-6-Astra and GPT-6.1-Sol until you choose. Before your first message, the chat shows the first of them, GPT-6-Astra when your plan offers it. Choose another before your first message if you like.

**Models in Settings.** **Settings** › **Models** lists every model your plan offers now. Tick the ones the AI and the sub-agents it starts may run on. The ticked ones come first, in the order you ticked them: the chat's menu lists them, and a new chat starts on the first. The AI can't start a sub-agent on a model you haven't ticked. A chat already on a model you untick keeps it, and the box still names it, until you choose another in the menu.

**The effort** is how hard the AI thinks before it answers: Low is faster, Medium gives careful answers at a good speed, and High thinks longer. Your chat starts at Medium. A new effort applies from the next reply, and the AI keeps its memory of the chat.

Rufi keeps the model and effort for your chat. You can't change them while a reply runs. Rufi says so: stop the reply, then change them. A new model answers from your next message, and it has the whole chat: the AI keeps its memory of the chat. A model of another provider starts a new thread there, with the chat's last messages. Messages that wait go to the new model.

**Context used.** In the chat's panel and page, a small grey ring with a percentage, such as "38%", shows beside the model and effort: how much of the AI's memory of the chat is in use, as the AI last reported it. Point at it, or move to it with Tab, to see what it means. It shows after the AI's first reply, and keeps its value when you reload. It changes after each step of a reply, not with each word. After a compaction or another model, it keeps the old value until the next reply. After a new thread, it shows nothing until the AI's first reply there. When the AI doesn't say how big its memory is, there is no ring. A full memory is normal: near full, Codex compacts the chat history.

## The AI's memory of the chat

Your chat is always kept whole in Rufi, and the AI can read all of it. The AI also keeps its own working memory of the chat, a thread, while you talk.

**Compacted.** When that memory gets near full, Codex, the AI's agent, compacts the chat history: it replaces the older part of the AI's memory with a summary, in the same thread. The chat shows "Compacting chat history…" while it runs, and "Chat history compacted" once it is done. A message you send meanwhile waits, as during any reply. If you stop the reply, or Rufi closes, while it compacts, the line goes away. Another model or effort keeps the same thread; if the new model has a smaller memory, the AI can compact, and the chat says so.

**New thread.** The AI starts a new thread only when its own copy of the chat is gone (for example after a restore, a move of Rufi's data, when its files were deleted, or when the AI's working state, `agents.sqlite`, is missing), or when you click **New thread** on a waiting message. The chat shows "New thread started" there. The new thread has the chat's last 10 messages that reached the AI, never one still waiting, and the AI reads further back when it needs to. When Rufi can't open the AI's thread for another reason, it doesn't start a new one by itself: your message waits as **Failed** with the error, **Send** and **New thread** (see [Waiting messages](#waiting-messages)).

**New rules.** When Rufi's rules for the AI change, after a Rufi update or when you choose another emergency region, the AI gets the new rules with your next message, and the chat shows no line. If the AI can't take them, your message waits as **Failed · The AI couldn't take Rufi's new instructions, so it can't reply now. Try again.**, with **Send** and **New thread**.

## What you typed but didn't send

Rufi saves what you type in the box as the chat's draft, a moment after you stop typing, and at once when you go to another page. It does this quietly: nothing shows under the box. A saved draft stays when you change the size of the chat, go to another page, reload the page or start Rufi again. Rufi never sends a draft by itself.

Wait a moment after you stop typing before you reload, close the page or stop Rufi: what you typed in the last moment before can be lost. If a save fails, the box says "Not saved" with the reason, and your text stays in this tab, also when you go to another page and back. Click **Retry** to save it again.

If you type in the chat in two browser tabs at once, the last save wins: each tab saves its text over the other's, and a tab shows the other's text only when you reload it. Type in one tab at a time.
