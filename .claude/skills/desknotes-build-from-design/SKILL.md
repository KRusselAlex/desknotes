---
name: desknotes-build-from-design
description: Use when building or changing any DeskNotes screen, so it follows the owner's Claude Design export instead of invented styling.
---

# Build DeskNotes screens from the design export

1. Find the export the owner shared (a folder with `*.dc.html`, `desknotes-tokens.css`,
   `desknotes-icons.js`). Read the frames' HTML for exact sizes, spacing and states;
   serve the folder locally and view it in a browser to see them.
2. New tokens or icons: update `src/styles/tokens.css` and `src/components/icons.ts`
   from the export. Never hard-code colours or sizes the tokens already cover.
3. Implement every state the design shows (empty, error, narrow, locked, dark…), with
   keyboard access and visible focus.
4. Check in the mocked preview: `npm run dev`, open `/preview.html?w=note&id=a2` or
   `?w=manager`, resize to the design's window size, compare screenshots.
5. Then verify in the real app with the `desknotes-verify-ubuntu` skill.
6. If a screen has no design, ask the owner; do not invent one. Do not commit the
   export's `support.js` or `_ds/` folder (third-party runtime, unknown license).
