# Signing in

Rufi's AI runs on Codex, with your ChatGPT plan. Codex signs in with your ChatGPT account, and Claude with your Claude account. Each signs in by itself, in your browser, and keeps and renews its own sign-in in your data folder. Rufi keeps no password or token of its own.

You can sign in in Rufi, or with terminal commands.

## Sign in in Rufi

1. Click **Sign in with ChatGPT**: in the first run, or click "Not signed in" at the bottom of the sidebar, **Sign in** in **Settings** › **Sign-in**, or **Sign in** by the chat's box after you sent while signed out. The **Sign in** page has Codex and Claude, each with its own button.
2. Your browser opens on the sign-in page: ChatGPT's for Codex, Claude's for Claude. If it doesn't open, click **open the sign-in page** in Rufi.
3. Sign in there.
4. Go back to Rufi. It goes on by itself when you are signed in.

Rufi waits up to 5 minutes for you, for one sign-in at a time. If the sign-in doesn't finish, Rufi says why; click the button to try again.

## Your sign-in in Settings

**Settings** › **Sign-in**, at the top of Settings, shows Codex and Claude as each reports itself:

- Codex signed in: with your ChatGPT account's email. **Manage usage** opens your ChatGPT plan's usage page in your browser.
- Claude signed in: Rufi shows that it is, not as whom.
- Not signed in: click **Sign in**, as above.
- When Rufi can't ask Codex or Claude, for example because Claude isn't installed on your Mac, it shows why.

## Sign in from the terminal

These commands can't run while Rufi runs, because they use the same data folder. Stop Rufi first (Ctrl-C in the terminal where `pnpm start` runs), and run `pnpm start` again when you're done.

1. Run `pnpm rufi signin` to sign Codex in, or `pnpm rufi signin claude` for Claude. Each runs the provider's own sign-in on your data folder (`codex login`, `claude auth login`). Your browser opens on its sign-in page; if it doesn't, use the link it shows.
2. Sign in there.

To check, run `pnpm rufi status`. It shows whether Codex and Claude are signed in, each in its own words.

## Staying signed in

Codex and Claude renew their sign-ins by themselves. If one ends, for example because you signed out in your ChatGPT or Claude settings, Rufi shows you're signed out, and you sign in again.

## What is kept, and where

| What                    | Where                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| Codex's ChatGPT sign-in | `codex/auth.json` in your data folder, kept by Codex                            |
| Claude's sign-in        | Your Mac's Keychain, kept by Claude for the `claude` folder in your data folder |

The AI's commands can't read either. A backup holds neither, and a move leaves both behind: after a restore or a move, sign in to each again.

## Sign out

Signing out is in the terminal only. Stop Rufi, then run `pnpm rufi signout` for Codex, or `pnpm rufi signout claude` for Claude. Each signs itself out.

Signing out doesn't remove your records or your data folder.
