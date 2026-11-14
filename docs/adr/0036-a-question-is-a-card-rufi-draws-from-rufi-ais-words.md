# 0036 · A question is a card Rufi draws from Rufi AI's words

**Date:** 15 Nov 2026 · **Status:** accepted

Rufi AI often ends a reply with a question that has a few clear answers ("Save these 6 results?"). Mahesh chose on 14 and 15 Nov 2026 that Rufi draws such a question as a small card of its own, the same way every time, from words Rufi AI gives: a key, an optional short line or list naming what the person approves, the question, and the answers. All analysis (charts, comparisons) stays before the card in the reply. A click on an answer is the person's message through the normal send, quoting the card; Rufi AI judges it as any message and saves with its tools, after a clear yes, with a receipt. The card shows that it was answered. To change their mind, the person types.

## The tool

Rufi AI asks with `ask` on Rufi's MCP server. It returns at once with the card's id and its link, `rufi:/chat/questions/<id>`; nothing waits for the person. The card is a line of the chat of its own kind, `question`, written with the call that made it in one transaction, where the call came in the reply: text written before it is above it, text after it below. Its `card` column keeps Rufi AI's words as they came, with `"kind": "choice"` so other kinds can come; its text is the card as Markdown, for a screen that doesn't draw cards.

- **Who asks.** Only Rufi AI, the chat's own agent. The door gives a sub-agent's calls its title, and the write is given only to a call without one; a sub-agent's tools leave `ask` out, and it sends its question to its parent. Codex's and Claude's own helpers are off (ADR 0026); one that came back would ask as Rufi AI.
- **Replay.** Rufi's id for the call (`<agent>/<conversation>/<provider call id>`) is the key: the same call again finds its kept call in this chat and returns its card, with other words too.

Considered: a fenced block in the reply, as visuals are (ADR 0034). It would sit exactly where it was written, but every reader would have to find it in the reply's text, a broken one would show only when drawn and never reach Rufi AI, and "answered" would need storing by the reply and its place anyway.

## The answer

A message that answers a card carries the card's quote: a chip pointing at it (`{type: "question", id, answer?}`), with the answer's place when a click sent it. The core checks it against the chat (a card of this chat, an answer it has) and names it by the card's key, never the screen's words. Only an unchanged click has an answer: an edit of a waiting message keeps the quote and drops it, and the box keeps a quote without one.

The card is answered when the click's message goes to Rufi AI (`sent`), in the same transaction, unless another click did first. Not when the core accepts it: a waiting message can still be edited or removed, and the card would show an answer Rufi AI never got. A later click still goes as a message, and Rufi AI sees the first answer and any receipt before it saves again.

Considered: answering the card when the message is accepted (the click shows done at once, but can be withdrawn); a table of answers (the card's line holds the first one).

## What Rufi AI reads

One quote, `> [<key>](rufi:/chat/questions/<id>)`, goes before the person's words wherever Rufi AI reads a message: its input, `read_chat` and a new thread's history. Each card there shows its link and the answer a click chose, and `read_chat` gives one card by its id. So an answer always names its own card, also after the chat was summarised or when two cards share a key.

## Drawing it

Each screen draws the card natively, the Mac with React and the iPhone with SwiftUI, with no web view: it is Rufi's own fixed shape, as a host draws its own question prompts. Considered: one HTML card in the locked visual frame on both screens (one place to change its look, but a web view for every yes or no, new messages through the frame's checked scripts, and a card the iPhone can't show while the Mac is out of reach).

Until both screens draw it, Rufi AI isn't given `ask` (`HELD`), and a screen shows a card's text. ADR 0035's buttons in visuals stay until then.
