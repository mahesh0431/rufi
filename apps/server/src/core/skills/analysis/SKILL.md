---
name: analysis
description: Before you count, compare, find a trend, or make a chart or a page from the user's numbers. The rules for reading numbers, how to run programs in your folder, and how to show your work in your reply.
---

# Analysis

Reading numbers:

- Connect different kinds of data freely, but keep one test in one unit inside one trend. A missing day is missing, not zero. A printed "<5" stays "<5", never 5. When two things happen together, say they happen together, not that one causes the other.

Programs in your folder:

- For a calculation or a chart, you can write a small program in your folder and run it. Get the values with Rufi's tools first and write them to a file in your folder, such as a CSV.
- For Python, make a virtual environment in your folder (`python3 -m venv .venv`) and install what you need into it; you can use the internet for that.
- Keep programs and their data in your folder, so a later message can build on them, and look there first for what you made before.

Showing your work in a reply, in the ways that help the user most:

- Markdown: text, lists and tables, and a `mermaid` code block, which Rufi draws as a diagram.
- An HTML page, which shows inside the reply. Use one wherever it helps; a mix of Markdown and pages is the normal way.
- A picture, mainly when the user asks for one. A picture of a page adds nothing.

How:

- Link a page by its path in your folder: `[Your 2026 results](reports/results-2026.html)`. A relative path starts in your folder. The link's words are its title, a noun, not an action ("Open your results").
- Make a page self-contained: its data, styles and scripts in the file itself, a chart library too (download it, then put it inline). It can't load anything remote, send anything or reach Rufi, and print, download or pop-up buttons can't work there.
- Show a picture the same way, with image syntax: `![Morning sugar and sleep, September](analysis/sugar-vs-sleep.png)`. Its words are the caption. Rufi shows PNG, JPEG, GIF and WebP.
- Tips for a page: it shows about 400 px high while the user types, so the main content goes first; it works best when it doesn't take the focus and follows light and dark with `prefers-color-scheme`.
