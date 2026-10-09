# Documents

You can add lab reports and other documents to Rufi as PDFs or photos. Rufi keeps each original exactly as it came, so you can always look at it again. This page says how to add documents, what Rufi does with photos taken together, and how to look at an original.

Rufi doesn't read your documents yet: each one shows **Not read yet**.

## Add documents

1. In the sidebar, click **Documents**.
2. Click **Add documents** and choose one or more files. You can also drop files on the page.

Rufi takes PDFs and photos in JPEG, PNG or HEIC (the format of iPhone photos). It knows a file by its content, not by its name.

### Photos taken together

When you choose two or more photos at once, Rufi first shows them in a list, with **3 photos → one document**. This is for one report that you photographed page by page: the photos become the pages of one document.

- To change the order of the pages, drag a photo to its place. With the keyboard, go to a photo's handle and press the Up or Down arrow.
- To make each photo a document of its own, turn the switch off.
- Click **Add … documents** to add them, or **Cancel** to add nothing.

A PDF is always a document of its own, also when you add it together with photos.

### The same file again

Rufi adds each file only once for a person. When a file has the same content as a document you already added, Rufi says **was already added** and links to that document; nothing new is added. It looks at the content, so a copy with another name is found too. Two files with the same name but different content are two documents.

### When Rufi doesn't add a file

If one of the files isn't a PDF, JPEG, PNG or HEIC photo, is damaged, or is a PDF protected with a password, Rufi says which file and why, and adds none of the files you chose. Remove that file and add the others again. For a PDF with a password, save a copy without the password and add that.

## Your documents

The Documents page lists everything you added, newest first:

| Column   | What it shows                                                          |
| -------- | ---------------------------------------------------------------------- |
| Document | The file's name as you added it, and its pages or how many more photos |
| Kind     | A lab report, prescription, letter or other; empty until Rufi reads it |
| Date     | The document's date; empty until Rufi reads it                         |
| Added    | The day you added it                                                   |
| Status   | **Not read yet**                                                       |

To show one kind only, choose it in the list at the top left.

## Look at an original

Click a document's name. Rufi opens the original over the page:

- A PDF opens in the built-in PDF viewer, where you can go through its pages, zoom and search.
- Photos show one under the other, in the order of the pages. A HEIC photo shows through a JPEG copy that Rufi made when you added it; if that copy is missing, Rufi makes it again and says **Preparing the photo…** meanwhile.

A link inside a PDF doesn't open: Rufi's window always stays in Rufi.

To close it, click **×** or press Esc. While you work in a PDF, Esc goes to the PDF viewer; click **×** instead.

In a browser that has no PDF viewer, Rufi says so and offers **Save a copy**, to open the PDF on your Mac.

## Where your documents are kept

The originals are in the `files` folder in your data folder, each named by its content's fingerprint (its SHA-256 hash). Rufi writes each file to disk completely before the document shows in Rufi. Your backups and the export hold every original (see [Backups and export](backups-and-export.md)).

You can't delete a document yet.
