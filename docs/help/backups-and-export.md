# Backups and export

Rufi makes a backup of your record each day, and you can take all your data out of Rufi as one file. This page says what a backup holds, how to restore one, and what an export holds.

## Backups

While Rufi runs, it makes a backup when it starts and then once a day. If Rufi was closed for some days, it makes one when it starts again; it doesn't make up the days it missed.

A backup is a copy of your record: your people, their records with all their history, your conversations, your drafts and Rufi's settings. Rufi checks each backup before it keeps it. A backup that fails its check, or that Rufi stopped in the middle, never counts, and your last good backup stays.

A backup doesn't hold:

- your ChatGPT sign-in: a restored copy starts signed out;
- the list of AI models (`models.json`): a restored copy uses the default list;
- the AI's own files, such as the messages that wait for the AI;
- Rufi's log.

Rufi keeps the newest backup of each of the last 7 days that had one, and of each of the last 4 weeks that had one: about 5 weeks. It removes older backups only after a new backup passed its check, so it never removes your last good backups, however long Rufi was closed.

The backups are in the `backups` folder in your data folder, one folder for each backup, named by the date and time it was made (for example `2026-10-08-091403`).

> **Note:** Backups protect you from a mistake or a damaged database. They are on the same Mac as your record, so they don't protect you if you lose the Mac or its disk.

### See your backups

Open **Settings**. Under **Backups**, Rufi shows when it made the last good backup. If the last try failed, or a backup in the folder is damaged, Rufi says when and why, and when your last good backup is from. Rufi keeps showing a failed try, also after it starts again, until a backup works.

To make a backup now, click **Back up now**.

## Restore a backup

A restore puts a backup into a new folder. Your current data folder doesn't change. You then start Rufi on the new folder.

1. Find the backup you want: open the `backups` folder in your data folder. For example, in the terminal:

   ```
   ls "$RUFI_HOME/backups"
   ```

2. In the Rufi folder, run `pnpm rufi restore` with the backup's folder and a new folder for the copy. The new folder must not exist yet, or be empty. For example:

   ```
   pnpm rufi restore "$RUFI_HOME/backups/2026-10-08-091403" ~/Rufi-restored
   ```

   Rufi checks the backup, copies it into the new folder and checks the copy. It doesn't need Rufi to be stopped.

3. Rufi shows the command that opens the copy. Run it, for example:

   ```
   RUFI_HOME=/Users/you/Rufi-restored pnpm start
   ```

4. Sign in with ChatGPT again: the copy starts signed out (see [Signing in with ChatGPT](signing-in.md)).

The copy is a Rufi of its own: it can run next to the Rufi of your current data folder. To use the copy from now on, set `RUFI_HOME` to the new folder each time you start Rufi.

What the restored copy has:

- Everything that was in your record when the backup was made. Anything you added or changed after that isn't there. Anything you removed after that is back.
- Your conversations and drafts. A reply that was running when the backup was made shows as interrupted. Nothing is sent by itself.
- Messages that were waiting for the AI don't come back. Your next message starts the AI afresh with the conversation's last messages.

If Rufi refuses:

- **The folder isn't empty:** choose a new folder. Rufi never restores over anything.
- **The backup isn't as it was made, or is damaged:** choose an older backup.
- **Another Rufi uses the folder:** stop it, or choose another folder.

Use the new folder only after the command says the backup is restored. If the command stopped before that (for example, you pressed Ctrl-C), delete the new folder and restore again. A restore that stopped while it copied leaves a `restoring` folder in the new folder, and Rufi won't start on it.

## If your record is missing

If `rufi.sqlite` is gone from a data folder that had a record, Rufi doesn't start, so that it never shows an empty record in place of yours. It says that the record is missing. Restore your last backup into a new folder, as above.

## Export your data

An export is one zip file with everything in your record, your conversations and Rufi's settings, so that your data is never locked in Rufi.

1. Open **Settings**.
2. Under **Export**, click **Export my data**.
3. In the Rufi app, choose where to save the file. In a browser, it goes to your downloads.

The file is named for the day, for example `rufi-export-2026-10-08.zip`. In it:

| In the zip    | What it is                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| `README.md`   | What the files are, and how the values are written                             |
| `export.json` | The export's format and version, and each table's columns and number of rows   |
| `json/`       | Every table of your record, exactly as Rufi stored it, one file for each table |
| `csv/`        | The same tables, to open in a spreadsheet                                      |

Rufi checks the export against your record before it gives it to you. An export never holds your ChatGPT sign-in, the AI's own files, Rufi's log or the list of AI models.

> **Warning:** The export holds your health record as plain files. Keep it where only you can open it, and delete it when you no longer need it.
