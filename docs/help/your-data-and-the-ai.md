# Your data and the AI

Rufi keeps your records on your Mac. This page says where they are, what the AI sends, and what Rufi writes in its log.

## Where your data lives

Everything is in one data folder on your Mac. Today you choose it with the `RUFI_HOME` setting before you run Rufi.

| In the data folder | What it is                                                                           |
| ------------------ | ------------------------------------------------------------------------------------ |
| `rufi.sqlite`      | The record: people, documents, reports and results                                   |
| `chatgpt.json`     | Your sign-in details, without secrets (see [Signing in with ChatGPT](signing-in.md)) |
| `logs/`            | Rufi's log (see below)                                                               |
| `codex/`           | The AI's own files: its settings and its copies of your conversations                |
| `workspace/`       | The folder where the AI works                                                        |
| `rufi.lock`        | A short-lived file while Rufi changes the sign-in                                    |

Rufi makes its new folders and files so that only your Mac user account can open them. It doesn't change a folder that already existed, so who can open a folder you chose depends on that folder's permissions and on who can use your Mac account.

> **Note:** When you ask Rufi something, the AI reads the parts of your record it needs. That text goes to the AI service you signed in with (today OpenAI, through your ChatGPT plan) so it can answer. See [OpenAI's policies](https://openai.com/policies/) for how they handle it.

## What Rufi logs

Rufi writes its own log to `logs/rufi.log` in the data folder, to help find problems. Each line is a fixed event with checked details: the event's name, the names of the AI's messages and of Rufi's tools, statuses, error codes and timings.

The log never holds your words, the AI's replies, health text or your sign-in. It stays on your Mac. At 10 MB Rufi starts a new file, and it keeps five files at most.

With `--debug`, `pnpm rufi ask` also shows these same lines in the terminal.

This is about `logs/rufi.log` and its older copies only. The AI's own files in `codex/` are separate.
