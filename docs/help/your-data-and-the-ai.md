# Your data and the AI

Rufi keeps your records on your Mac. This page says where they are, what the AI sends, what Rufi keeps of your conversations, and what Rufi writes in its log.

## Where your data lives

Everything is in one data folder on your Mac. Today you choose it with the `RUFI_HOME` setting before you run Rufi.

| In the data folder | What it is                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `rufi.sqlite`      | The record (people, documents, reports and results) and your conversations (see below)                                                     |
| `chatgpt.json`     | Your sign-in details, without secrets (see [Signing in with ChatGPT](signing-in.md))                                                       |
| `models.json`      | The AI models Rufi may use. It starts with the strongest ones, and you can edit the list                                                   |
| `logs/`            | Rufi's log (see below)                                                                                                                     |
| `codex/`           | The AI's own files: its settings, its own copies of your conversations with what its tools returned, and the messages that wait for the AI |
| `workspace/`       | The folder where the AI works                                                                                                              |
| `core.json`        | There while Rufi runs: how `pnpm start` finds the running Rufi to open it again. Rufi removes it when it stops                             |
| `rufi.lock`        | A folder that is there while Rufi or a Rufi command uses the data folder, so only one of them does at a time                               |
| `credentials.lock` | A short-lived folder while Rufi changes or renews the sign-in                                                                              |

When Rufi creates your data folder, it makes it private to your Mac user account. The files Rufi writes in it, such as `rufi.sqlite` and the log, are private to your account too. Rufi doesn't change a folder that already existed, so who can open a folder you chose depends on that folder's permissions and on who can use your Mac account.

> **Note:** When you ask Rufi something, the AI reads the parts of your record it needs. That text goes to the AI service you signed in with (today OpenAI, through your ChatGPT plan) so it can answer. See [OpenAI's policies](https://openai.com/policies/) for how they handle it.

## Your conversations

Rufi keeps each conversation in `rufi.sqlite`: your messages, the AI's replies, and one line for each thing the AI did, such as reading your record or searching the web. Rufi saves each part before it shows it, so what you see is what was saved.

Rufi doesn't keep the AI's tool outputs or its reasoning. The AI's own copies in `codex/` hold more, as long as the AI keeps them.

## What Rufi logs

Rufi writes its own log to `logs/rufi.log` in the data folder, to help find problems. Each line is a fixed event with checked details: the event's name, the names of the AI's messages and of Rufi's tools, statuses, error codes and timings.

The log never holds your words, the AI's replies, health text or your sign-in. It stays on your Mac. At 10 MB Rufi starts a new file, and it keeps five files at most.

With `--debug`, `pnpm rufi ask` also shows these same lines in the terminal.

This is about `logs/rufi.log` and its older copies only. The AI's own files in `codex/` are separate.
