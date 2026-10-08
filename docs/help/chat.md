# Talking to Rufi

The chat is where you talk with Rufi's AI about your record. It is one conversation that you can see in three sizes: the chat bar, the chat panel and the chat page. Rufi keeps every conversation, and what you typed but didn't send.

## The chat bar

The chat bar is the box at the bottom right of every page. It says "Ask or tell Rufi about" and your name.

The bar shows the conversation you chose last. Point at the bar, or move into it with Tab, to see which conversation it is. When you have no conversation yet, clicking the box starts one.

Each browser tab keeps its own conversation open: a choice in one tab doesn't change another. When you open Rufi again, the bar shows the last choice Rufi saved. A choice made just before you close Rufi may not be remembered.

Under the box, in every size of the chat, "AI can be wrong" reminds you to check what the AI says.

## The chat panel

Click the bar, or press ⌘J, to open the chat panel over the page. The panel is always the same size, and the page stays as it is behind it.

At the top of the panel:

- **The conversation's name.** Click it to choose another conversation, or **New conversation**.
- **Minimise** (–) closes the panel. Esc does the same, and puts you back where you were. When a menu is open, Esc closes the menu first.
- **Open as page** (the arrows) shows the conversation as a page.
- **The model** that answers, with "Using ChatGPT plan". **Manage usage** opens your ChatGPT plan's usage page in your browser.

Press ⌘J again to close the panel.

## The chat page

Each conversation has its own page, listed under **Conversations** in the sidebar. The page shows the same conversation as the panel, with the same box. When you open a conversation's page, the bar shows that conversation.

In a small window, the chat opens as a page instead of the panel.

## Starting a conversation

Click **New conversation** in the sidebar, or choose it at the top of the panel. New conversation opens an empty conversation, listed as "New conversation". Until it opens, the box says "Starting a new conversation…" and you can't send from it. If you choose another conversation meanwhile, the new one is only listed. If you go to another page meanwhile, Rufi stays on that page, and the chat bar shows the new conversation. Its first message that Rufi takes gives it a name, in the panel, on the page and in the sidebar. An empty conversation stays in the list.

Before your first message, the chat says what goes to OpenAI. See [Your data and the AI](your-data-and-the-ai.md).

## Sending a message

Type in the box and press Enter, or click the send button. Shift-Enter starts a new line.

When you send, Rufi first saves your text: the box says "Saving…". If you reload or close the page then, the text since the last "Saved" can be lost, and nothing is sent. Then, while Rufi sends your message, the box says "Sending…" and you can't change it. If another tab changed the text just before, nothing is sent and the box shows that tab's text. You can use another conversation meanwhile. The box clears when the AI has taken your message. If the AI can't take it, your text stays in the box with the reason.

If you reload or close the page while the box says "Sending…", nothing is lost: when you come back, the box is empty if the AI took the message, still says "Sending…" until it knows, or shows your text again if the message hadn't left yet. If you stop the reply or Rufi stops during a send, or the AI doesn't answer it, Rufi keeps your text, but it may not know whether the AI got it: the box says so. Check the conversation before you send it again. Rufi never sends a message again by itself: send it again when you want to.

A message can have up to 10,000 characters. When the box has more, it says so, and Rufi doesn't keep or send the text until you make it shorter.

## What you see

- **Your messages**, on the right.
- **The AI's replies**, which appear as the AI writes them. Replies can have lists and tables. Links in a reply open in your browser, outside Rufi. A reply never shows pictures.
- **One line for each thing the AI did**, such as reading your Overview or running a command. A tick means it was done. Other signs mean it is running, it failed, or it stopped.
- **Based on**, a link under an answer once the reply has ended. It opens where the answer comes from. See [Where an answer comes from](#where-an-answer-comes-from).
- **Receipts**, with a tick, each time the AI saved something to your record: "Saved", then one line for each change. Rufi writes them. See [Changing your record](#changing-your-record).
- **How a reply ended**, when it didn't finish: for example "Stopped.", or that your ChatGPT plan's usage limit has been reached, with the time it resets.

## Asking about your record

Ask the AI about your record in your own words, for example "What was my last HbA1c?", "How many times did I have a headache this year?" or "How has my HbA1c changed since I started creatine?". The AI reads your Overview. For anything more, such as earlier results, counts, dates, or one kind of data beside another, it queries your record.

What the AI's queries can do:

- **Only this person's record.** A query reads only the record of the person the conversation is about. It can't read another person's record, your conversations or Rufi's settings. Rufi chooses the person, not the AI.
- **Only read.** A query can't change anything.
- **Removed records too.** Records you removed, and the earlier versions of amended results, stay readable, marked as removed or replaced.
- **Limits.** Rufi stops a query after 5 seconds, and gives the AI at most 200 rows and 32 KB of them. When a limit cuts what came back, Rufi tells the AI, and the AI says in its answer what that means. A query that failed or was stopped gives the AI its error, never an empty list of rows.

If your record changes while the AI answers, for example a save in another conversation, two of its reads can see the record before and after the change. Used shows what each read got back.

## Where an answer comes from

Under an answer, once the reply has ended, the **Based on** link opens two parts:

- **How**: the AI's own words on where the answer comes from: your record, read in this reply or earlier in the conversation, the web, or general knowledge. It also says how the AI got the answer, for example which results it compared.
- **Used**: what Rufi saw the AI read in that reply, one line for each read: a query on your record with the number of rows it gave back, your Overview, a web search or a web page, a command. Rufi makes this list itself, not from the AI's words.

Used is what the AI read, not proof that each read supports the answer. For the web, Rufi sees what was searched or opened, not the text of the page. When a read failed, stopped or was cut by a limit, its line says so. When the AI answers from something it read earlier in the conversation, Used is empty for that reply, and How says so. If How and Used don't agree, ask the AI.

Anything that changes what an answer means, such as only two readings or a missing month, is in the answer itself, not only under Based on.

Small talk, such as "thanks", has no How, and no Based on when the AI read nothing. While a reply runs, Based on isn't there yet. If you stop a reply, or Rufi closes during it, what the AI wrote so far stays, without How; Based on shows only what the AI had read.

The AI writes How at the end of its reply, and Rufi shows it under Based on, not in the answer. If the AI forgets it, the answer has no How.

## Changing your record

You change your record by telling the AI in the chat. Nothing changes until you say yes.

1. Tell the AI, for example "I stopped creatine because of a stomach upset".
2. The AI reads your record, then says what it will save and asks you. Nothing is saved yet.
3. Say yes to save it. If you say no, ask a question, or say "yes, but explain first", the AI saves nothing.
4. The conversation shows a receipt with a tick: "Saved", then one line for each change, with the record's name in bold and each changed detail as old → new. For example:

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

If you stop the reply while the AI saves, the save can still finish. Then its receipt shows in the conversation, and the AI sees it the next time you write. Say "undo that" if you don't want it.

## While the AI replies

**Stop.** The stop button (the square) ends the reply now, in every size of the chat. What the AI wrote so far stays.

**Waiting messages.** When you send a message while the AI replies, the message waits, and runs after the reply. Waiting messages show above the box. For each one you can:

- **Edit** it (the pencil), then **Save**.
- **Move up** or **Move down**, to change the order.
- **Delete** it (the bin).

After you stop a reply, waiting messages keep waiting. Send a message, or click **Run now** (the play sign) on one of them, to go on.

**Steer.** To change the reply that is running, type in the box and click **Steer** instead of sending. Your text goes into that reply, and the AI takes it at its next step. The conversation shows it as your message, marked "Steer".

## The model

Each conversation has its own model. To change it, click the model's name in the panel or on the page, and choose another. A new conversation shows the first model it can use; choose another before your first message if you like.

You can't change the model while a reply runs or messages wait. Rufi says so: stop the reply, or run or delete the waiting messages, then change it. A new model starts the AI afresh with the conversation's last 10 messages.

## What you typed but didn't send

Rufi saves what you type in the box as the conversation's draft, a moment after you stop typing, and at once when you go to another conversation or page. Under the box, "Saving…" turns into "Saved". A saved draft stays when you change the size of the chat, go to another page, reload the page or start Rufi again. Rufi never sends a draft by itself.

Wait for "Saved" before you reload, close the page or stop Rufi: what you typed in the last moment before can be lost. If a save fails, the box says "Not saved" with the reason, and your text stays in this tab, also when you go to another conversation and back. Click **Retry** to save it again.

If you type in the same conversation in two browser tabs, the tab that saves or sends second shows "Changed in another tab" and the newer text, and sends nothing. Go on from there.
