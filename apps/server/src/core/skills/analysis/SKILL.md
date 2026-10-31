---
name: analysis
description: Before you count, compare, find a trend, or make a chart or a page from the user's numbers. The rules for reading numbers, how to run programs in your folder, and how to show your work in your reply.
---

# Analysis

Reading numbers:

- Connect different kinds of data freely, but keep one test in one unit inside one trend. A missing day is missing, not zero. A printed "<5" stays "<5", never 5. When two things happen together, say they happen together, not that one causes the other.

Programs in your folder:

- For a calculation, you can write a small program in your folder and run it. Get the values with Rufi's tools first and write them to a file in your folder, such as a CSV. A program can also write a page with its chart.
- For Python, make a virtual environment in your folder (`python3 -m venv .venv`) and install what you need into it; you can use the internet for that.
- Keep programs and their data in your folder, so a later message can build on them, and look there first for what you made before.

Showing your work in a reply, in the ways that help the user most:

- Markdown: text, lists and tables, and a `mermaid` code block, which Rufi draws as a diagram.
- A trend, which Rufi draws in the reply from a short `openui-lang` block: the usual way to show one test's values over time. `visuals.md`, beside this file, says how. Its values are the record's, as the record keeps them.
- An HTML page, which shows inside the reply: the way to show any other chart, and anything richer, such as a page of results for a doctor. A mix of Markdown and pages is the normal way.
- A picture, when the user asks for a picture. A chart as a picture, or a picture of a page, adds nothing. Never use image generation for the user's values: an image model can change the numbers it draws.

How:

- Link a page by its path in your folder: `[Your 2026 results](reports/results-2026.html)`. A relative path starts in your folder. The link's words are its title, a noun, not an action ("Open your results").
- Make a page self-contained: its data, styles and scripts in the file itself. A chart can be SVG in the page, or a chart library (download it, then put it inline). It can't load anything remote, send anything or reach Rufi, and print, download or pop-up buttons can't work there.
- Show a picture the same way, with image syntax: `![Where the patch goes](pictures/patch-sites.png)`. Its words are the caption. Rufi shows PNG, JPEG, GIF and WebP.
- Tips for a page: it shows about 400 px high while the user types, so the main content goes first; it works best when it doesn't take the focus and follows light and dark with `prefers-color-scheme`.
- Rufi paper is one way to style a page, so it looks like the rest of Rufi: `paper.css`, beside this file. Put its whole text in the page's `<style>` and `class="rufi-paper"` on the body; the file's first comment names its parts (a title and lead, facts, sections, a table, a note, a chart, a source line). It stays on white paper in light and dark. Use it, your own styles, or plain Markdown, whichever fits.
