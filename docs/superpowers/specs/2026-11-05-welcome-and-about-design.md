# Welcome note and fuller About page — design (DES-29)

Date: 2026-11-05 · Jira: DES-29 (parent DES-6, Milestone 5)
Source: DES-29, agreed with the owner on 2026-11-02 after mockups
(`.superpowers/brainstorm/…/welcome-v2.html` option 3 and `welcome-and-about.html`).
Anything not fixed there is marked **(my call)**.

## 1. Why
A new user gets no word on who made DeskNotes, what it is for, or that notes never leave the
computer. The About section shows only the name, version, licence, data folder and one privacy
line. The author's name appears nowhere, and there are no links to the source, the issue
tracker or the owner's other tools.

## 2. Welcome note (first launch)

**When.** The welcome note is created only when **all** of these hold:
- the database file was created by this launch, so it was a new, empty file (schema 0 before
  migrations) **(my call)**;
- it has no notes;
- the setting `first_run_done` is not set.

The first rule means an existing user who has deleted every note never gets a welcome note
after an upgrade.

Creating the note and setting `first_run_done` happen in **one transaction**, so the welcome
note is created at most once, ever. It never comes back after the user deletes it, including
after a restart.

**What.** It is one ordinary note: no special flag, so it can be moved, recoloured, archived or
deleted like any other.
- Colour: lemon (`DEFAULT_COLOR` `#fff4a3`).
- Size: the default size.
- Position: centred on the primary work area (the usual new-note cascade does not apply).

Content is plain Tiptap JSON paragraphs using only nodes and marks the allowlist already has
(paragraph, text, bold). It has no link.

> **Welcome 👋**
> DeskNotes keeps your notes **on this computer only**. Nothing goes online.
> Use the palette on my top bar to change my colour. Delete me when you're done.
> — Alex

**(my call, owner to check):** the agreed line was "Right-click me to change my colour."
DeskNotes has no right-click menu: colour is changed with the **Colour** (palette) button in
the note's top bar, which shows on hover. So the line is changed to something true.

- The title follows the normal rule (derived from the content as for any note).
- The window title never shows note text (existing rule).
- `search_text` is computed by the normal save path.

## 3. About page (Settings → About)
Built with existing tokens, `.dn-about*` styles and icons from `icons.ts`, in this order (mockup
`welcome-and-about.html`):

1. **Header.**
   - The app icon (my call: the real app icon, `src-tauri/icons/128x128.png`, copied into
     `src/assets/`, shown at 48 px; the mockup's "D" tile was a placeholder).
   - **DeskNotes**, then `version x.y.z` with a **Copy** button, then `MIT license`.
   - Copy puts `DeskNotes x.y.z · <OS name>` on the clipboard, for example
     `DeskNotes 0.2.0 · Ubuntu 24.04.5 LTS`. The OS name comes from Rust (`PRETTY_NAME` in
     `/etc/os-release`, else "Linux").
   - After copying, the button reads **Copied** for 2 s (my call).
2. **Purpose:** "Sticky notes for your desktop that work offline and keep everything on your
   computer."
3. **Credit:** "Made by **Alex** (KRusselAlex) and DeskNotes contributors."
4. **Three links**, each followed by a small muted "opens browser":
   - **Source code on GitHub** → https://github.com/KRusselAlex/desknotes
   - **Report a problem or suggest an idea** → https://github.com/KRusselAlex/desknotes/issues
   - **More free open-source tools by Alex** → https://github.com/KRusselAlex (the ticket's
     target; the owner may change it)
5. **Data folder:** the existing "Your notes are stored in" block, with its path and
   **Open folder** button, unchanged.
6. **Privacy line** (existing, extended): "No data leaves this computer. The app never
   connects to the internet on its own."
7. **Footer:** "Icons derived from Lucide (ISC). **Third-party notices** · **Licence text**".
   - Both are links that open the files on GitHub at the running version's tag:
     `…/blob/v<version>/THIRD_PARTY_NOTICES.md` and `…/blob/v<version>/LICENSE`.
   - (my call: the .deb ships only the licence and the AppImage ships neither, so a
     same-version web link is the one place both always exist.)

## 4. How links open (no network by the app)
- One new command, `open_external_link(id)`. It takes **only a fixed link id**:
  `source`, `issues`, `more_tools`, `notices`, `license`. The URL is built in Rust and opened in
  the system browser with the existing opener plugin. The webview never passes a URL; an
  unknown id is a validation error.
- A link opens only when clicked. The app itself still makes no connection.

## 5. Out of scope
- Update check, "what's new", a welcome window, or a link inside the welcome note.
- Any telemetry.
- Changing how links inside notes open.

## 6. Acceptance (from DES-29)
- **Fresh data folder:** exactly one welcome note with the text above, centred.
  - Restart: it is not duplicated.
  - Delete it and restart: it does not come back.
- **Existing database** (with notes, or with none): no welcome note.
- **About:** shows the icon, version + Copy, licence, purpose, credit, three links, the folder,
  the privacy line and the footer links.
  - Copy puts the right text on the clipboard.
  - Each link opens the system browser.
  - No request is made by the app otherwise.
- **Gate:** `npm test && npm run lint && npm run typecheck`, `cargo test --workspace`, clippy
  `-D warnings`, `cargo fmt --check`.
- A real-app check is recorded in `docs/testing/`.
