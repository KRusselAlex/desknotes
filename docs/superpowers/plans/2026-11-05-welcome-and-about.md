# Welcome Note and About Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the very first launch, show one ordinary welcome note. Give Settings → About the author, purpose, version copy, three links and the licence notices.

**Architecture:**
- The core decides and creates the welcome note in one transaction, only for a database it has just created.
- The shell places it centred at start-up.
- About links go through one Rust command that maps fixed ids to URLs.
- The About pane is rebuilt from existing tokens and styles.

**Tech Stack:** Rust (`desknotes-core`, Tauri 2 shell, existing `tauri-plugin-opener`), React 19 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-welcome-and-about-design.md`

## Global Constraints

- **Branch and commits:**
  - Branch `feat/welcome-about` from `main`.
  - Conventional Commits with the footer `Refs: DES-29` and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (one co-author line).
  - Never stage `.superpowers/`.
- **Project rules:**
  - All SQL lives in the core.
  - `src/ipc` is the only `invoke` caller.
  - Validate in Rust.
  - Note content is validated Tiptap JSON.
  - Window titles never show note text.
  - Tokens, styles and icons come only from `tokens.css` / `icons.ts` / existing `.dn-about*` / `.dn-btn-outline`.
- **No network by the app.** A link opens the system browser only when clicked. The webview never passes a URL.
- **Copy, verbatim:**
  - **Welcome note**, four paragraphs (bold marked with `**`):
    1. `**Welcome 👋**`
    2. `DeskNotes keeps your notes **on this computer only**. Nothing goes online.`
    3. `Use the palette on my top bar to change my colour. Delete me when you're done.`
    4. `— Alex`
  - **Purpose:** `Sticky notes for your desktop that work offline and keep everything on your computer.`
  - **Credit:** `Made by **Alex** (KRusselAlex) and DeskNotes contributors.`
  - **Links:**
    - `Source code on GitHub`
    - `Report a problem or suggest an idea`
    - `More free open-source tools by Alex`

    Each is followed by a muted `opens browser`.
  - **Privacy:** `No data leaves this computer. The app never connects to the internet on its own.`
  - **Footer:** `Icons derived from Lucide (ISC).` then the links `Third-party notices` · `Licence text`.
  - **Copy button:** `Copy`, which reads `Copied` for 2 s. The clipboard text is `DeskNotes <version> · <OS name>`.
- **Link ids and URLs (Rust only):**

  | id | URL |
  |---|---|
  | `source` | https://github.com/KRusselAlex/desknotes |
  | `issues` | https://github.com/KRusselAlex/desknotes/issues |
  | `more_tools` | https://github.com/KRusselAlex |
  | `notices` | https://github.com/KRusselAlex/desknotes/blob/v{version}/THIRD_PARTY_NOTICES.md |
  | `license` | https://github.com/KRusselAlex/desknotes/blob/v{version}/LICENSE |
- **Settings key:** `first_run_done` (value `"1"`). No migration.
- **Gate before every commit:**
  - `npm test && npm run lint && npm run typecheck`
  - `cargo test --workspace`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo fmt --all --check`

## Review Focus

1. **At most once, ever.**
   - A second call, a reopen, and a reopen after the note is deleted (or trashed and emptied) never create another one.
   - The note and the flag are written in one transaction.
   - Owner: Task 1, `welcome_is_created_once`.
2. **Existing users never get it.**
   - A database that existed before this launch gets no welcome, even with zero notes. That covers an upgrade from 0.2.0 with every note deleted.
   - Owner: Task 1, `existing_database_gets_no_welcome`, using the v0.2.0 fixture emptied of notes.
3. **The content is ordinary.**
   - It passes the same validation as a user save, with only paragraph, text and bold.
   - Its plain text is exactly the four lines.
   - The title comes from the normal path.
   - Owner: Task 1, `welcome_content_is_plain_and_valid`.
4. **No URL crosses IPC.**
   - `open_external_link` refuses any id outside the five.
   - The `{version}` comes from the app's own version.
   - No capability is widened.
   - Owner: Task 2, `link_url_knows_only_fixed_ids`.
5. **Failures don't block start-up.**
   - If creating the welcome note fails, the app still starts with the manager shown, and the error is only logged.
   - Owner: Task 2 (reviewed by reading the code).

---

### Task 1: Core — welcome note, once

**Files:**
- `crates/desknotes-core/src/db/mod.rs`: remember whether this `Database` was created new.
- New `crates/desknotes-core/src/db/welcome.rs`: the content and `create_welcome_note`.
- `db/settings.rs`: the `FIRST_RUN_DONE` key.
- Tests in `welcome.rs`, plus one in `tests/release_upgrade.rs` or a sibling integration test for the fixture case.

**Interfaces (produced):**
- `Database::was_created_new(&self) -> bool`: true when `user_version` was 0 when this connection was initialised. That is true for `open_in_memory` too, which is harmless because nothing calls the welcome automatically.
- `Database::create_welcome_note(&self) -> CoreResult<Option<Note>>`:
  - Returns `Some(note)` only when `was_created_new()`, the `notes` table has no rows at all (any state), and `first_run_done` is unset.
  - It creates the note with `DEFAULT_COLOR`, saves the welcome content through the same validated path as `save_content`, and sets `first_run_done = "1"`. All of this happens in one transaction (follow the existing transaction pattern in `db/`).
  - Otherwise it returns `None` and writes nothing.
- `pub fn welcome_content() -> serde_json::Value` (or a `&'static str` JSON constant): the four paragraphs from Global Constraints.

**Steps:**
- [ ] Write failing tests:
  - `welcome_is_created_once`:
    - `open()` on a new temp path gives `Some`;
    - a second call gives `None`;
    - reopen gives `None`;
    - delete permanently, reopen, `None`.
  - `existing_database_gets_no_welcome`:
    - a database opened, closed and reopened with zero notes gives `None`;
    - a copy of `release-0.2.0.db` with all notes deleted (plain rusqlite before opening) gives `None`.
  - `welcome_content_is_plain_and_valid`:
    - the content passes `validation`;
    - its node and mark types are a subset of {doc, paragraph, text, bold};
    - the plain text joined by `\n` equals the four lines without `**`;
    - colour is `DEFAULT_COLOR`;
    - `first_run_done` is `"1"`.
- [ ] Run and expect FAIL.
- [ ] Implement.
- [ ] Run, expect PASS, then clippy.
- [ ] Commit: `feat(core): welcome note on a new database, created once`.

### Task 2: Shell — start-up placement, OS name, link command

**Files:**
- `src-tauri/src/windows/mod.rs` (`restore_on_startup`);
- `src-tauri/src/platform/` (new `os_name()`; platform code stays here);
- `src-tauri/src/commands/settings.rs` (`SettingsView.os_name`, `open_external_link`);
- `src-tauri/src/lib.rs` (register);
- `src/ipc/commands.ts`, and the settings type wherever `SettingsView` is declared in TS;
- `src/dev/preview.tsx` (mocks).

**Behaviour:**
- **Start-up.** In `restore_on_startup`, before `notes_to_show`, call `create_welcome_note`.
  - On `Some(note)`, save its window geometry centred on the primary work area (`work_areas(app)[0]`) at the note's default size, through the core's existing window-geometry setter, so it opens there like a restored note.
  - On `Err`, `eprintln!` only and carry on.
  - The note then appears through the normal `notes_to_show` path, and the manager-at-start-up rule is unchanged: the welcome note counts as a note.
- **OS name.** `platform::os_name() -> String` returns `PRETTY_NAME` from `/etc/os-release` (unquoted), falling back to `"Linux"` on Linux. On other targets it returns a plain OS name.
  - It is a pure parser `parse_pretty_name(&str) -> Option<String>`, unit-tested with a sample file, quoted and unquoted.
  - `SettingsView` gains `os_name`.
- **Link command.** `link_url(id: &str, version: &str) -> Option<String>` is pure and tested.
  - `#[tauri::command] open_external_link(app, id: String) -> IpcResult<()>` returns a validation error for an unknown id, otherwise opens the URL with `app.opener().open_url(url, None::<&str>)`.
  - The version comes from `app.package_info().version`.
  - Check how app commands are permitted in this project (a build manifest or the capability tests near `note_settings.rs:190-210`). Allow the new command for the `settings` window only, if the project scopes commands per window. Widen nothing else.
- **TS.**
  - `commands.openExternalLink(id: AboutLink)` with `type AboutLink = "source" | "issues" | "more_tools" | "notices" | "license"`.
  - `SettingsView.osName: string`.
  - Preview mocks for both.

**Steps:**
- [ ] Write failing tests:
  - `link_url_knows_only_fixed_ids`: the five ids map to the exact URLs (with the version substituted), and `""`, `"https://x"`, `"SOURCE"` and `"../"` give `None`.
  - `parse_pretty_name` cases.
  - A TS test that `openExternalLink` invokes `open_external_link` with `{ id }`.
- [ ] Run and expect FAIL.
- [ ] Implement.
- [ ] Run, expect PASS, then the full gate.
- [ ] Commit: `feat: welcome note opens centred; About link command and OS name`.

### Task 3: About pane

**Files:**
- `src/features/settings/SettingsWindow.tsx` (the `about` section) and its test;
- `src/styles/settings.css` (extend `.dn-about*` with existing tokens only);
- `src/assets/app-icon.png` (copied from `src-tauri/icons/128x128.png`, shown at 48 px, `alt=""`);
- `src/dev/preview.tsx`.

**Behaviour (order fixed by the spec §3):**
1. Header: icon, then **DeskNotes**, then `version x.y.z`, then the **Copy** button, then `MIT license`.
   - Copy uses `navigator.clipboard.writeText` with `DeskNotes ${version} · ${osName}`.
   - On success the label is `Copied` for 2 s.
   - On failure it shows the existing error style with "Could not copy." (my call).
2. Purpose line.
3. Credit with bold Alex.
4. The three links as buttons styled as links (keyboard reachable, real `<button>`s), each with a muted `opens browser`, calling `commands.openExternalLink(id)`.
5. The folder block, unchanged.
6. The privacy line with the new text.
7. The footer with the two link buttons.

**Steps:**
- [ ] Write failing tests:
  - the order and texts of the section;
  - Copy writes the exact text and shows `Copied` for 2 s, using fake timers on `Date` and `setTimeout` as this file already does elsewhere, or real timers with `waitFor`;
  - each of the five link buttons calls `openExternalLink` with its id;
  - the privacy text;
  - the folder block still opens the folder.
- [ ] Run and expect FAIL.
- [ ] Implement.
- [ ] Run, expect PASS, then the gate.
- [ ] Check the preview `http://localhost:1420/preview.html?w=settings` (or the existing settings preview route) in light and dark, at the settings window's size.
- [ ] Commit: `feat(settings): fuller About page with author, links and version copy`.

### Task 4: Real-app check and docs (controller)

**Steps:**
- [ ] Release build. Run it isolated (scratch `HOME`, `dbus-run-session`, `Xvfb`) on an empty data folder:
  - exactly one welcome note, centred, lemon, with the four lines;
  - restart: still one;
  - delete it, restart: none;
  - an existing scratch database (the 0.2.0 fixture with its notes deleted): no welcome note.
- [ ] Clipboard and links need a real session: run on the owner's screen only with their agreement, or record them as owner checks.
  - Clicking each link opens the browser.
  - Copy pastes `DeskNotes 0.2.0 · Ubuntu 24.04.5 LTS`.
- [ ] Record the results in `docs/testing/m5-welcome-about-verification.md`, plus a CHANGELOG Unreleased entry.
- [ ] Commit: `docs: welcome note and About page verification`.
