# Backups and export

Rufi makes a backup of your health record and your documents each time it starts and then each day, and you can take all your data out of Rufi as one file. This page says what a backup holds, how to restore one, and what an export holds.

## Backups

Rufi makes a backup each time it starts, and then once a day while it runs. If Rufi was closed for some days, it doesn't make up the days it missed. The backup at start runs in the background: you can use Rufi while it runs.

A backup is a copy of your record: your people, their records with all their history, your chat, your drafts, the follow-up notices already shown and Rufi's settings, and every document you added, exactly as it came. Rufi checks each backup before it keeps it: the copy of the record, and each document against its fingerprint. A backup that fails its check, or that Rufi stopped in the middle, never counts, and your last good backup stays.

If a document's file is missing from your data folder, or has changed, the backup fails and Settings says so: **a document file is missing or changed**. Your last good backup stays. To get the file back, restore that backup into a new folder (see below).

A backup doesn't hold:

- your ChatGPT sign-in: a restored copy starts signed out;
- the list of AI models (`models.json`): a restored copy uses the default list;
- the AI's own files, such as its own copy of the chat;
- the JPEG copies Rufi makes to show HEIC photos: Rufi makes them again when they are needed;
- Rufi's log.

Rufi keeps the newest backup of each of the last 7 days that had one, and of each of the last 4 weeks that had one: about 5 weeks. It removes older backups only after a new backup passed its check, so it never removes your last good backups, however long Rufi was closed.

The backups are in the `backups` folder in your data folder, one folder for each backup, named by the date and time it was made (for example `2026-10-08-091403`). Each holds `rufi.sqlite`, the documents in `files`, and `backup.json`. Where your Mac's disk allows (as its own disk does), a document in a backup is a clone: it takes no more space until the file changes.

Each hour Rufi checks that its newest backup is still whole: the record, and that each document is there with its size. It reads every document again only when it makes a backup and when you restore one.

### The backup before an upgrade

Sometimes a new Rufi stores your record in a new way. Then, when it starts, it upgrades your record before it opens it:

1. It makes a backup of your record as it was, with your documents, and checks it. This backup goes in `backups/before-upgrade`, and Rufi never removes it: delete old ones yourself when you no longer need them.
2. It upgrades your record in one step. If anything goes wrong, your record stays as it was, and Rufi says that it couldn't upgrade it.

The upgrade that brought Lab results and Measurements puts every result you saved before on Lab results: Rufi doesn't guess which were measurements. To move one, tell Rufi in the chat.

If the backup fails (for example, the disk is full), Rufi doesn't upgrade your record and doesn't start. Make space, and start Rufi again.

If your record was made by a newer Rufi (for example, you went back to an older Rufi), Rufi doesn't open it and doesn't change it. Update Rufi to open it.

> **Note:** Backups protect you from a mistake or a damaged database. They are in your data folder, on the same disk as your record, so they don't protect you if you lose the Mac or that disk. To keep a copy somewhere else, copy a backup's folder to another disk or to the cloud. Never put the data folder itself in the cloud (see [Your data and the AI](your-data-and-the-ai.md#where-your-data-lives)).

### See your backups

Open **Settings**. Under **Backups**, Rufi shows when it made the last good backup. If the last try failed, or a backup in the folder is damaged, Rufi says when and why, and when your last good backup is from. After Rufi starts again, Settings shows the backup Rufi makes as it starts: while it runs, and then whether it worked. An older failure isn't shown again.

To make a backup now, click **Back up now**. When it is done, Settings says **Backed up just now**.

## Restore a backup

A restore puts a backup into a new folder. Your current data folder doesn't change. You then start Rufi on the new folder.

A restore brings back your record as it was when the backup was made, signed out. To put your data on another disk as it is now, with your sign-in and all your backups, move it instead (see [Move your data](your-data-and-the-ai.md#move-your-data)).

1. Find the backup you want: open the `backups` folder in your data folder (**Settings** › **Data folder** › **Show in Finder**). For example, in the terminal, for the data folder that Rufi made:

   ```
   ls ~/Library/"Application Support"/Rufi/data/backups
   ```

   The backups made just before an upgrade are in `backups/before-upgrade`.

2. In the Rufi folder, run `pnpm rufi restore` with the backup's folder and a new folder for the copy. The new folder must not exist yet, or be empty. For example:

   ```
   pnpm rufi restore ~/Library/"Application Support"/Rufi/data/backups/2026-10-08-091403 ~/Rufi-restored
   ```

   Rufi checks the backup, copies it into the new folder with every document, and checks the copies. A backup from an older Rufi is upgraded in the new folder; the backup itself doesn't change. It doesn't need Rufi to be stopped.

3. Rufi shows the command that opens the copy. Run it, for example:

   ```
   RUFI_HOME=/Users/you/Rufi-restored pnpm start
   ```

4. Sign in with ChatGPT again: the copy starts signed out (see [Signing in with ChatGPT](signing-in.md)).

The copy is a Rufi of its own: it can run next to the Rufi of your current data folder. To use the copy from now on, set `RUFI_HOME` to the new folder each time you start Rufi (see [Start Rufi on another folder](your-data-and-the-ai.md#start-rufi-on-another-folder)).

What the restored copy has:

- Everything that was in your record when the backup was made, with its documents. Anything you added or changed after that isn't there. Anything you removed after that is back.
- In a backup from before Rufi had Lab results and Measurements, every result counts as a lab result: Rufi can't tell which were measurements. To move one, tell Rufi in the chat, for example "my blood pressure from August is a measurement".
- Your chat and drafts. A reply that was running when the backup was made shows as interrupted. Nothing is sent by itself.
- Messages that were waiting for the AI come back held, above the box, marked **From a backup: it waited when the backup was made.** Nothing goes to the AI by itself: **Send** each one again, or **Remove** it. A message Rufi was giving the AI when the backup was made shows **Not sure this reached the AI.** (see [Waiting messages](chat.md#waiting-messages)).
- Your next message starts the AI afresh with the chat's last messages, and the chat shows a quiet line there.
- Which follow-up notices you already had, as of the backup. A notice the Rufi app showed after the backup was made can show once more (see [Follow-ups](follow-ups.md#notices-on-your-mac)).

If Rufi refuses:

- **The folder isn't empty:** choose a new folder. Rufi never restores over anything.
- **The backup isn't as it was made, or is damaged:** choose an older backup.
- **A document file in the backup is missing or changed:** delete the new folder, and restore an older backup.
- **The backup is from a newer Rufi:** this Rufi can't restore it, and nothing is changed. Update Rufi, and restore again.
- **Another Rufi uses the folder:** stop it, or choose another folder.

Use the new folder only after the command says the backup is restored. If the command stopped before that (for example, you pressed Ctrl-C), delete the new folder and restore again. A restore that stopped while it copied leaves a `restoring` folder in the new folder, and Rufi won't start on it.

## If your record is missing or empty

If `rufi.sqlite` is gone from a data folder that had a record, Rufi doesn't start, so that it never shows an empty record in place of yours. It says that the record is missing. It also refuses an existing empty `rufi.sqlite` and leaves it unchanged. Restore your last backup into a new folder, as above.

## Export your data

An export is one zip file with everything in your record, your chat, your documents and Rufi's settings, so that your data is never locked in Rufi.

1. Open **Settings**.
2. Under **Export**, click **Export my data**.
3. In the Rufi app, choose where to save the file. In a browser, it goes to your downloads.

Settings says **Exported your data as a zip**. The file is named for the day, for example `rufi-export-2026-10-08.zip`, unless you give it another name. In it:

| In the zip    | What it is                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| `README.md`   | What the files are, and how the values are written                             |
| `export.json` | The export's format and version, and each table's columns and number of rows   |
| `json/`       | Every table of your record, exactly as Rufi stored it, one file for each table |
| `csv/`        | The same tables, to open in a spreadsheet                                      |
| `files/`      | Every document you added, exactly as it came, named by its fingerprint         |

Rufi checks the export against your record and your documents before it gives it to you. If a document's file is missing or changed, Rufi doesn't make the export, and says so. An export never holds your ChatGPT sign-in, the AI's own files, Rufi's log or the list of AI models.

The `results` table holds your lab results and measurements; its `category` column says which each one is, `lab` or `measurement`.

In the export, a document's file is named by its fingerprint, with its type: for example `files/7f4a…8b54.pdf`. The `document_pages` table says which document and page each file is, and the name it had when you added it.

> **Warning:** The export holds your health record as plain files. Keep it where only you can open it, and delete it when you no longer need it.
