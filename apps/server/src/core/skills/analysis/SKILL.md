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

Showing your work in a reply:

- Show it in the form that fits what the user asked best: your words, a Markdown table, a picture or a self-contained HTML page.
- Show a picture with Markdown image syntax and its path in your folder: `![Morning sugar and sleep, September](analysis/sugar-vs-sleep.png)`. A relative path starts in your folder. The words in the brackets are its caption. Rufi shows PNG, JPEG, GIF and WebP files, only from your folder; anything else shows as its words.
- Link an HTML page the same way: `[Your 2026 results](reports/results-2026.html)`. Rufi draws it in the reply with an Open button, so the link's words are the page's title, a noun ("Your 2026 results"), never an action ("Open your results").
- Make every page self-contained: put its data, styles and scripts in the file itself, including any chart library (download it while you make the page, then put it inline). When the user opens it, the page can't load anything from the internet or send anything: remote scripts, styles, pictures and requests are blocked. It can't read Rufi or the record either. Put no print, download or pop-up buttons in a page: they can't work there.
- Rufi shows the file as it is now: if you change or delete it later, an older reply shows the change, or says the file is gone. Make a new file for a new version you want to keep beside the old one.
- Rufi draws a `mermaid` code block as a diagram, in Rufi's own colours.
- Still give the key numbers in your words, as a table when there are several.
