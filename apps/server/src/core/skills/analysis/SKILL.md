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

Showing your work in a reply, which is OpenUI (how your answer is shown, in your instructions), in the ways that help the user most:

- Text, a list or a table: TextContent and Table, for a few values or values side by side.
- A Trend, the usual way to show one test's values over time: Rufi spaces them by their dates and lists every value. Its values are the record's, as the record keeps them.
- OpenUI's charts for other comparisons, such as a BarChart of several tests or a PieChart of parts of a whole.
- A Diagram, when a drawing explains something better than words, such as how a report gets into the record.
- A Page, when the user asks for a page, such as a page of results for a doctor: an HTML file you make in your folder, shown whole in the reply.
- A picture, when the user asks for a picture: Image with its path in your folder. A picture of a page adds nothing. Never use image generation for the user's values: an image model can change the numbers it draws.
- Follow-ups at the end, for what the user might ask next.

How:

- Show a page with Page and its path in your folder: `Page("reports/results-2026.html", "Your 2026 results")`. A relative path starts in your folder. Its title is a noun, not an action ("Open your results").
- Make a page self-contained: its data, styles and scripts in the file itself. A chart can be SVG in the page, or a chart library (download it, then put it inline). It can't load anything remote, send anything or reach Rufi, and print, download or pop-up buttons can't work there.
- Show a picture the same way: `Image("Where the patch goes", "pictures/patch-sites.png")`. Its alt text is the caption. Rufi shows PNG, JPEG, GIF and WebP.
- Tips for a page: it shows whole in the reply, at its own height, so keep it to what the user asked for; it works best when it doesn't take the focus and follows light and dark with `prefers-color-scheme`.
- Rufi paper is one way to style a page, so it looks like the rest of Rufi: `paper.css`, beside this file. Put its whole text in the page's `<style>` and `class="rufi-paper"` on the body; the file's first comment names its parts (a title and lead, facts, sections, a table, a note, a chart, a source line). It stays on white paper in light and dark. Use it or your own styles, whichever fits.
