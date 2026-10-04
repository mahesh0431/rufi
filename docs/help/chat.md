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

Click **New conversation** in the sidebar, or choose it at the top of the panel. New conversation opens an empty conversation, listed as "New conversation". Its first message that Rufi takes gives it a name, in the panel, on the page and in the sidebar. An empty conversation stays in the list.

Before your first message, the chat says what goes to OpenAI. See [Your data and the AI](your-data-and-the-ai.md).

## Sending a message

Type in the box and press Enter, or click the send button. Shift-Enter starts a new line.

While Rufi sends your message, the box says "Sending…" and you can't change it, in this tab or another. You can use another conversation meanwhile. The box clears when the AI has taken your message. If the AI can't take it, your text stays in the box with the reason.

If you reload or close the page while the message is on its way, nothing is lost: when you come back, the box is empty if the AI took the message, or still says "Sending…" until it knows. If Rufi stops during a send, or the AI doesn't answer it, Rufi keeps your text, but it may not know whether the AI got it: the box says so. Check the conversation before you send it again. Rufi never sends a message again by itself: send it again when you want to.

A message can have up to 10,000 characters. When the box has more, it says so, and Rufi doesn't keep or send the text until you make it shorter.

## What you see

- **Your messages**, on the right.
- **The AI's replies**, which appear as the AI writes them. Replies can have lists and tables. Links in a reply open in your browser, outside Rufi. A reply never shows pictures.
- **One line for each thing the AI did**, such as reading your Overview or running a command. A tick means it was done. Other signs mean it is running, it failed, or it stopped.
- **How a reply ended**, when it didn't finish: for example "Stopped.", or that your ChatGPT plan's usage limit has been reached, with the time it resets.

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
