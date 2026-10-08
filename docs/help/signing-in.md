# Signing in with ChatGPT

Rufi's AI runs on your own ChatGPT plan. You connect Rufi to your ChatGPT account once, in your browser, and Rufi keeps you signed in.

You can sign in in Rufi, or with terminal commands.

## Sign in in Rufi

1. Click **Sign in with ChatGPT**: in the first run, or click "Not signed in" (or "ChatGPT plan can't be used") at the bottom of the sidebar.
2. Your browser opens on ChatGPT's sign-in page. If it doesn't open, click **open the sign-in page** in Rufi.
3. Sign in to ChatGPT and approve Rufi. The first time, Rufi also registers itself as an app on your account.
4. Allow **ChatGPT plan use**. Without it, the AI can't answer. To allow it later, sign in again.
5. Go back to Rufi. It goes on by itself when you are signed in.

Rufi waits up to 5 minutes for you. If the sign-in doesn't finish, Rufi says why; click **Sign in with ChatGPT** to try again.

## Sign in from the terminal

These commands can't run while Rufi runs, because they use the same data folder. Stop Rufi first (Ctrl-C in the terminal where `pnpm start` runs), and run `pnpm start` again when you're done.

1. Run `pnpm rufi signin`. Your browser opens on ChatGPT's sign-in page. If it doesn't open, use the link Rufi shows. With `--no-open`, Rufi only shows the link.
2. Sign in to ChatGPT, approve Rufi and allow **ChatGPT plan use**, as above.

Rufi waits up to 5 minutes for you. Then it shows the account you signed in with.

To check, run `pnpm rufi status`. It shows the account, whether ChatGPT plan use is allowed, and until when the current access is valid.

## Staying signed in

Rufi renews the sign-in by itself when it needs to. If ChatGPT ends the sign-in, for example because you disconnected Rufi in your ChatGPT settings, Rufi asks you to sign in again.

## One account for each data folder

A data folder belongs to the first ChatGPT account that signs in with it. If you sign in with another account, Rufi refuses it and keeps the first one, also after you sign out. To use another account, use another data folder.

## What Rufi keeps

| What                                                                           | Where                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Your account email, your account ID and Rufi's app ID. No passwords or tokens. | `chatgpt.json` in your data folder        |
| The sign-in itself                                                             | Your Mac's Keychain, under "Rufi ChatGPT" |

## Sign out

Signing out is in the terminal only. Stop Rufi, then run `pnpm rufi signout`. Rufi asks ChatGPT to end its sign-in and removes the sign-in from your Keychain.

If ChatGPT can't confirm it, Rufi still signs out on your Mac and tells you. To be sure, disconnect Rufi in your ChatGPT settings.

Signing out doesn't remove your records or your data folder.
