# Talking to Rufi

The chat is where you talk with Rufi's AI about your record. You have one chat with Rufi, and you can see it in three sizes: the chat bar, the chat panel and the chat page. Rufi keeps the whole chat, and what you typed but didn't send. To talk about something new, just say so.

## The chat bar

The chat bar is the box at the bottom right of the Overview. It says "Ask or tell Rufi about" and your name, and shows the model and effort that answer, such as "GPT-6-Astra Medium". It is your chat, the same as the panel and the page, and the same in every browser tab. Help and Settings have no chat bar: to talk to Rufi from there, click **Chat with Rufi** in the sidebar.

Under the box, in every size of the chat, "AI can make mistakes. Check important info." reminds you to check what the AI says. When you are signed in, "Using ChatGPT plan" comes before it, and **Manage usage** opens your ChatGPT plan's usage page in your browser.

## The chat panel

Click the bar, or press ⌘J, to open the chat panel over the page. The panel is always the same size, and the page stays as it is behind it.

A thin bar at the top of the panel has:

- **Minimise** (–), which makes the panel the chat bar again. Esc does the same, and puts you back where you were. When a menu is open, Esc closes the menu first.
- **Chat with Rufi**, the chat's name.
- **Open as page** (the arrows), which shows the chat as a page.

Press ⌘J again, or click anywhere outside the panel, to close it. What you typed stays in the box.

## The chat page

Click **Chat with Rufi** in the sidebar, on any page, to open your chat as a page. The page shows the same chat as the panel, with the same box. In a small window, the chat opens as a page instead of the panel.

Before your first message, the chat says what goes to OpenAI. See [Your data and the AI](your-data-and-the-ai.md).

## Reading back

The chat opens at its latest messages. Scroll up to see older ones: Rufi loads them as you go, and what you read stays where it is on the screen. If Rufi can't load them, the chat says so: click **Try again**.

A line between days says which day the messages under it are from: "Today", "Yesterday", then the day, such as "Thu 8 Oct", with the year when it isn't this year. The days are in your Mac's time zone.

## Sending a message

Type in the box and press Enter, or click the send button. Shift-Enter starts a new line.

When you send, Rufi takes your message into its queue and empties the box, in one step. While it does, the box says "Sending…" for a moment and you can't change it. Rufi sends the text in this box, also when another tab saved other text just before. Then the message goes to the AI: at once when nothing else runs, or in its turn (see [Waiting messages](#waiting-messages)). It shows in the chat when the AI starts on it.

If Rufi can't be reached when you send, your text stays in the box with the reason, also when you leave the chat or reload the page in this tab. Press Enter again: if Rufi did take the first one, it knows this is the same message and doesn't take it twice.

Rufi never sends a message again by itself. If something goes wrong after Rufi took your message, the message shows above the box with the reason, and you choose: **Send** it (again) or **Remove** it.

A message can have up to 10,000 characters. When the box has more, it says so, and Rufi doesn't keep or send the text until you make it shorter.

## What you see

- **Your messages**, on the right.
- **The AI's replies**, which appear as the AI writes them. Replies can have lists and tables. Links in a reply open in your browser, outside Rufi. A reply never shows pictures.
- **One line for each thing the AI did**, such as reading your Overview or running a command. A tick means it was done. Other signs mean it is running, it failed, or it stopped.
- **Based on**, a link under an answer once the reply has ended. It opens where the answer comes from. See [Where an answer comes from](#where-an-answer-comes-from).
- **Receipts**, with a tick, each time the AI saved something to your record: "Saved", then one line for each change. Rufi writes them. See [Changing your record](#changing-your-record).
- **A visit brief's line**, with a page sign and **Open**, when the AI made a brief for you. Rufi writes it. See [Visit brief](visit-brief.md).
- **Rufi's lines**, with a bell and "Rufi" above them, when something happened outside the chat. Rufi writes them, never the AI, and they are never your words. See [Rufi's lines](#rufis-lines).
- **How a reply ended**, when it didn't finish: for example "Stopped.", or that your ChatGPT plan's usage limit has been reached, with the time it resets.
- **A quiet line**, "The AI started afresh here. It can still read earlier messages.", where the AI started again with a new memory of the chat: after you changed the model, when Rufi changed the AI's tools, when the AI's own copy of the chat was lost (for example after a restore), or where the AI compacted its memory of a long chat. From there, the AI has the chat's last messages, and it reads further back when it needs to. See [The AI's memory of the chat](#the-ais-memory-of-the-chat).

## Asking about your record

Ask the AI about your record in your own words, for example "What was my last HbA1c?", "How many times did I have a headache this year?" or "How has my HbA1c changed since I started creatine?". The AI reads your Overview. For anything more, such as earlier results, counts or dates, it reads one kind of record, such as your results or your symptoms, all of them or between two dates. The AI does the counting and the comparing itself.

What the AI's reads can do:

- **Only this person's record.** A read gets only the records of the person whose chat it is. It can't read another person's record, the chat or Rufi's settings. Rufi chooses the person, not the AI.
- **Only read.** A read can't change anything.
- **Removed records too.** Records you removed, and the earlier versions of amended results, are in a read too, marked as removed or replaced.
- **Limits.** One read gives the AI at most 200 records and 32 KB of them, newest first. When there are more, Rufi tells the AI that the read was capped, and the AI reads fewer dates at a time or says in its answer what that means. A read that failed gives the AI an error, never an empty list.

If your record changes while the AI answers, for example because the AI saved something in the same reply, two of its reads can see the record before and after the change. Rufi keeps what each read got back with the chat.

## Where an answer comes from

Under an answer, once the reply has ended, the **Based on** link opens two parts:

- **How**: the AI's own words on where the answer comes from: your record, read in this reply or earlier in the chat, the web, or general knowledge. It also says how the AI got the answer, for example which results it compared.
- **Used**: which reads the AI made in that reply, and how each one ended: your Overview, your records of one kind (for example "Read your results in 2026 · 8 records"), a web search or a web page, a command. Rufi makes this list itself, not from the AI's words. What each read got back isn't shown here; Rufi keeps it with the chat.

Used is what the AI read, not proof that each read supports the answer. For the web, Rufi sees what was searched or opened, not the text of the page. When a read failed, stopped or was capped, its line says so. When the AI answers from something it read earlier in the chat, Used is empty for that reply, and How says so. If How and Used don't agree, ask the AI.

Anything that changes what an answer means, such as only two readings or a missing month, is in the answer itself, not only under Based on.

Small talk, such as "thanks", has no How, and no Based on when the AI read nothing. While a reply runs, Based on isn't there yet. If you stop a reply, or Rufi closes during it, what the AI wrote so far stays, without How; Based on shows only what the AI had read.

The AI writes How at the end of its reply, and Rufi shows it under Based on, not in the answer. If the AI forgets it, the answer has no How.

## Changing your record

You change your record by telling the AI in the chat. Nothing changes until you say yes.

1. Tell the AI, for example "I stopped creatine because of a stomach upset".
2. The AI reads your record, then says what it will save and asks you. Nothing is saved yet.
3. Say yes to save it. If you say no, ask a question, or say "yes, but explain first", the AI saves nothing.
4. The chat shows a receipt with a tick: "Saved", then one line for each change, with the record's name in bold and each changed detail as old → new. For example:

   > **Saved**
   >
   > - Changed medicine use **Creatine 5 g**: status _current_ → _stopped_
   > - Added symptom **Stomach upset**

   When a detail is long, its line shows the part around the change. Rufi writes the receipt itself, from what it saved, not from the AI's words. If the receipt is different from what the AI told you, trust the receipt and tell the AI.

The AI can save medicines you take, prescriptions, symptoms, conditions, allergies, results such as your weight or blood pressure, visits, procedures and immunisations, "no known allergies", and follow-ups.

What Rufi does when it saves:

- **Only what you said.** A detail you didn't give stays unknown. A date is saved only when you gave one, at the precision you gave it: "since 2019" stays a year. Rufi keeps your words for the date, such as "last Monday", and counts them from when you sent the message, not from when you said yes.
- **All or nothing.** When one part can't be saved, nothing is saved, and the AI tells you why.
- **Nothing is deleted.** A record you remove leaves your current record, and Rufi keeps its history.
- **One medicine, one use.** When you take a medicine in two ways, such as a morning and a night dose, stopping one doesn't stop the other. A prescription doesn't add a medicine you take.
- **"No known allergies" has a date.** It can't stay in your record beside an allergy that is active or whose status is unknown. When you tell the AI about such an allergy, it asks you to remove "no known allergies" in the same save.

Your record isn't shown on a page yet, except your results on the Overview. Ask the AI what is in it.

### Undo

Say "undo that". The AI reads the save and your record as it is now. It tells you what it will change back, and anything that changed after that save, and asks you. Say yes, and the AI saves the reverse, with its own receipt. The first save stays in the history.

### When a save and a stop meet

If you stop the reply while the AI saves, the save can still finish. Then its receipt shows in the chat, and the AI sees it the next time you write. Say "undo that" if you don't want it.

## While the AI replies

While the AI replies, the box and the chat bar say "Rufi is answering" and how many seconds it has taken so far.

**Stop.** The stop button (the square, where the send button was) ends the reply now, in every size of the chat. What the AI wrote so far stays.

**Stop.** After a Stop, nothing more goes to the AI until you send a message. Rufi keeps this also when you reload or Rufi starts again.

**Steer.** To change the reply that is running, type in the box and click **Steer** instead of sending. Your text goes into that reply, and the AI takes it at its next step. The chat shows it as your message, marked "Steer". If the reply ended just before, the box says "The reply had ended, so this wasn't passed into it. Send it as a new message." Your text stays in the box.

## Waiting messages

While the AI replies, the box says "Type to queue your next message…". When you send a message then, it waits in Rufi's queue, and goes to the AI after the reply, in order. What waits shows above the box, also after a reload, a restart of Rufi, or a change of model. For each of your waiting messages you can:

- **Edit** it (the pencil), then **Save**.
- **Move up** or **Move down**, to change the order.
- **Remove** it (the bin). It never goes to the AI.

The line above them says what happens next:

- **Waiting · these go in order after the reply**: they go by themselves.
- **Stopped · these go when you send a message**: you stopped a reply. Send a message, or click **Send now**, to go on. They go first, in order, then your new message.
- **Rufi restarted · these go when you send a message**: Rufi started again while messages waited. Nothing goes by itself after a restart: send a message, or click **Send now**.
- **Not sent · Rufi sends these only when you say**: some messages are held, as below.

A held message says why under it, and goes only when you click **Send** (or **Send again**) on it:

- **"Not sure this reached the AI."** Rufi stopped, or the AI didn't answer, while Rufi gave it the message. The AI may have it. Check the chat before you send it again. After this, nothing more goes to the AI until you send a message.
- **"You're signed out. Sign in, then Send."** Signing in alone sends nothing.
- **"From a backup: it waited when the backup was made."** After a restore, nothing from the past goes to the AI by itself.
- **The AI's reason**, when the AI couldn't take it, for example when none of your allowed models is offered.

## Rufi's lines

Some things happen outside your chat. Rufi tells you with its own line in the chat. For example, once Rufi reads documents, a line such as "Lab report · 12 Aug · 42 results read · 1 to check" says that a reading has finished. Rufi writes these lines, not the AI, and they are never your words.

When the AI should know too, Rufi gives it a note:

- **When nothing runs**, the AI gets the note at once, in a short reply of its own. In that reply the AI can only read your record: it can explain or ask, but it can't save anything. Only your own messages can save.
- **When a reply runs**, the note waits until the reply has ended. Notes that wait together go to the AI together, in one reply.
- **After a Stop, or when you're signed out**, the note waits above the box as "Rufi's note", marked **Rufi**, with "Goes to the AI with your next message." It goes once, with your next message, never as a reply of its own later. **Remove** it if the AI doesn't need it.

## The model and effort

The model and effort that answer show in the box, next to the send button, in every size of the chat: for example "GPT-6-Astra Medium". Click them to open one menu with both. When you aren't signed in, the menu can't list the models: click **Sign in with ChatGPT** in it to sign in.

**The model.** Your chat has one model at a time. To change it, choose another in the menu: a tick shows the one that answers now. Before your first message, the chat shows the first model in your list of models (`models.json`, see [Your data and the AI](your-data-and-the-ai.md)) that your ChatGPT plan offers now. In a new data folder, that is GPT-6-Astra. Choose another before your first message if you like. To make another model the first choice, put it first in the list.

**The effort** is how hard the AI thinks before it answers: Low is faster, Medium gives careful answers at a good speed, and High thinks longer. Your chat starts at Medium. A new effort applies from the next reply, and the AI doesn't start afresh.

Rufi keeps the model and effort for your chat. You can't change them while a reply runs. Rufi says so: stop the reply, then change them. Messages that wait go to the new model.

## The AI's memory of the chat

The AI keeps its own memory of the chat while you talk. When that memory gets long, the AI compacts it. Rufi starts the AI afresh only when it must: when you change the model, when Rufi's tools change, or when the AI's own copy of the chat is lost. Then the AI gets the chat's last 10 messages, and it can read further back in the chat when it needs to.

Each place where the AI started afresh or compacted its memory shows the quiet line "The AI started afresh here. It can still read earlier messages." It shows above the first reply that really came from the new start: a model you chose but didn't use shows no line. If the AI finishes compacting while Rufi isn't running, that place shows no line.

## What you typed but didn't send

Rufi saves what you type in the box as the chat's draft, a moment after you stop typing, and at once when you go to another page. It does this quietly: nothing shows under the box. A saved draft stays when you change the size of the chat, go to another page, reload the page or start Rufi again. Rufi never sends a draft by itself.

Wait a moment after you stop typing before you reload, close the page or stop Rufi: what you typed in the last moment before can be lost. If a save fails, the box says "Not saved" with the reason, and your text stays in this tab, also when you go to another page and back. Click **Retry** to save it again.

If you type in the chat in two browser tabs at once, the last save wins: each tab saves its text over the other's, and a tab shows the other's text only when you reload it. Type in one tab at a time.
