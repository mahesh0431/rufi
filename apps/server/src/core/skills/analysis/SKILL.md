---
name: analysis
description: Before you count, compare, find a trend, or chart the user's numbers, or make a picture. The rules for reading numbers, how to run programs in your folder, and how to show a picture.
---

# Analysis

Reading numbers:

- Connect different kinds of data freely, but keep one test in one unit inside one trend: a test's test_number values are all in its unit, as Rufi's chart of the test draws them. A missing day is missing, not zero. A printed "<5" stays "<5", never 5. When two things happen together, say they happen together, not that one causes the other.

Programs in your folder:

- For a calculation, you can write a small program in your folder and run it. Get the values with Rufi's tools first and write them to a file in your folder, such as a CSV.
- For Python, make a virtual environment in your folder (`python3 -m venv .venv`) and install what you need into it; you can use the internet for that.
- Keep programs and their data in your folder, so a later message can build on them, and look there first for what you made before.

A picture:

- When the user asks for a picture, make it in your folder and show it as a Markdown image of its path, such as `![Where the patch goes](pictures/patch-sites.png)`. Its alt text is the caption. Rufi shows PNG, JPEG, GIF and WebP. Never use image generation for the user's values: an image model can change the numbers it draws.
- A chart of the user's values is a visual in Rufi AI's reply, not a picture. Rufi AI draws it. An agent returns its findings and the exact values in Markdown, such as a table, and draws no visual.
