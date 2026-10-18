# 0020 · Rufi's name and its dog are not under the code's licence

**Date:** 17 Oct 2026 · **Status:** accepted

Rufi's look lives in one brand package, `packages/brand`: the colour tokens and the two font roles (`tokens.css`), the rules for people and agents (`DESIGN.md`), and the dog (`mark/`: its source `rufi.js`, its motion, the generator, the preview and every image made from them). The app reads it now and the website next, so a colour changes in one place and the agents that build Rufi can read the rules. The repository is public under the Apache License 2.0, so the dog becomes public when the package lands.

**The code is open, except the dog's folder; the name and the dog are not.** `TRADEMARKS.md` at the root says that the Rufi name and everything in `packages/brand/mark/`, its code included, belong to mahesh0431, all rights reserved, and that they may be used to talk about Rufi but not as another app's, fork's or service's name or logo. Two things are reserved, and they are separate. The copyright in the whole folder: the Apache License's grant (its section 2) doesn't reach it, so the drawing, its code and its images may not be copied or changed. And the name and the dog as marks: the Apache License never gives rights to a project's names and marks (its section 6). The note says both plainly and names the folder, so someone who forks Rufi knows to replace the folder and give the fork its own name and logo. Each file of the dog's source says so in a header comment, and each generated SVG in a comment of its own. `tokens.css` and `DESIGN.md` stay Apache 2.0: colours and rules are no identity on their own. `LICENSE` does not change.

**One folder holds the whole dog.** The reserved part is a path, `packages/brand/mark/`, so a file is in or out by where it is, with no list to keep. Nothing of the dog is copied into an app: the app draws it with `svg()` from the package, and its icons are the package's generated files.

Rejected:

- **The dog in a separate, private repository.** It ships inside every copy of the app and on the website anyway, so a private repository would protect nothing, and it would be a second source to keep in step that the agents building Rufi can't read.
- **The dog under Apache 2.0 with the code.** Its section 2 would let anyone copy, change and ship the drawing and its code. Section 6 would still keep the name and the mark, but the dog itself would be free to reuse, so a fork could look like Rufi.
- **A change to `LICENSE`.** The licence stays the standard text; the note sits beside it.

Registering the name and the dog as trademarks is a question for a lawyer before the public release.
