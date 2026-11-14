# 0035 · A visual's button sends its words as the person's message

**Date:** 12 Nov 2026 · **Status:** superseded by [ADR 0036](0036-a-question-is-a-card-rufi-draws-from-rufi-ais-words.md) (15 Nov 2026): Rufi AI asks with a question card, and a visual has no buttons. Added to [ADR 0034](0034-a-replys-visual-is-an-html-block-in-a-locked-frame.md)

When Rufi AI asks something with a few clear answers, such as a yes to a change it proposed, the person had to type the answer. Mahesh chose on 12 Nov 2026 that a visual can hold buttons for the answers. A click puts the button's message in the chat as the person's own, through the normal send, exactly as if they had typed it, and the AI reads it and acts as it would on typed words. It lives in the chat only: no button bar, no new record type, and no code that reads what an answer means.

## The button

A button is a plain `<button>` in the visual's HTML with its message in `data-rufi-send`:

```html
<button data-rufi-send="Yes, save metformin 500 mg, twice a day">Save</button>
```

- The button shows a few words; the attribute holds the whole message, so an old card clicked later still says what it answers.
- Rufi styles every such button the same way, as its own plain button in the theme's colours, with the app's focus ring. The AI leaves them unstyled.
- Nothing else in a visual sends anything. A `<button>` with no message, or an empty one, does nothing.

## How a click becomes a message

```
visual frame                        screen                                 core
card script: a click on
button[data-rufi-send]  ──{type: "rufi-visual-send", text}──▶ from its own frame only
                                    POST …/chat/messages  ──────────────▶ steer or queue, as typed
                                    {id, text, kind, draft: "keep"}
```

- **The card script makes it work, not the visual.** A visual still runs no script of its own (ADR 0034). Rufi's card script, already in every frame, listens for a click on such a button and posts its trimmed message to the framing page. The frame's policy, its refused elements and its sandbox don't change. Only the scripts' hashes change: the page's script holds the card script whole, and both hashes are worked out from their text.
- **The screen sends it through the normal route.** The Mac's chat sends it with its own id, no chips, `draft: "keep"` (the person's typed draft stays), and, while a reply runs, the way Settings › Chat › While a reply runs gives Enter in the box (steer or queue). The chat follows it as it follows a send from the box.
- **It goes only to the chat the card is in.** The frame gives only text; the person is the chat's own.
- **A double click sends once.** The card script ignores a click whose `detail` is above 1. A slower second click is a second message, as typing again would be.
- **A lost answer keeps its id.** When the request may have reached the core but its response was lost, the card keeps the send's id and text while it is on screen. The next click of the same button sends under that id, so the core takes it once. A success or a refusal ends that, and the next click is a new message. When a send fails, one line under the card says why, in the words the box would use.
- **Buttons stay live.** A card keeps no state on whether it was answered. A click on an old card sends its message again; the AI reads it in context and checks the record before saving again.

## Why no guard against the AI

A visual can't run script, so it can't send without a real click or key press. A card that tricks a click, such as one large see-through button, could send a message the person didn't mean. That is no worse than the AI acting on its own, which it already can; the AI is trusted. So nothing guards against it, and no consent step comes before a send.

## Considered

Other systems let a card send a message as the user: MCP-UI's `prompt` action (`{type: "prompt", payload: {prompt}}` to the host), the OpenAI Apps SDK's `sendFollowUpMessage` (now MCP Apps' `ui/message`), and the `sendPrompt` of Claude's interactive visuals. All keep the message apart from the button's label, and all run the card's own script. Rufi follows MCP-UI's shape, one message from the frame that the screen sends, but declares it on the button, because a visual runs no script.

- **A script call, as the others have:** it would mean letting a visual's own script run, which ADR 0034 refuses.
- **Sending the button's label as the message:** simpler, but unclear once the card is old.
- **Dropping a click while a reply runs, as one host does:** Rufi lets it go as a typed message would.
- **Keeping which button was clicked, or dimming it:** a new record for something the chat already shows.
