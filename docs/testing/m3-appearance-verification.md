# Milestone 3 — Settings → Appearance: verification on Ubuntu

Date: 2026-11-04 · Branch: `feat/m3-appearance` (f6e9655) · Jira: DES-34
Design: `docs/superpowers/specs/2026-11-04-appearance-settings-design.md` (owner's designs S4, B4 and High contrast)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | release binary (`npm run tauri build -- --no-bundle`), not the `.deb` |
| Data | isolated scratch folder (`XDG_DATA_HOME`), not the owner's notes. The owner's DeskNotes was quit for the run, with their agreement, and restarted afterwards. |
| Test notes | **A:** peach, see-through 80 %, no font or size of its own; title line, three lines, yellow highlight and red text. **B:** blue, its own font Amiri and size 20. |
| Method | The Settings window did not receive synthetic clicks (other windows covered it on the owner's screen), and the owner asked the run to go ahead without them. Each combination was written into the scratch settings table, the test build was restarted, and both note windows were captured. The note rows in the database were read before and after. |

## Checked in the real app

| Check | Result |
|---|---|
| High contrast on | Both notes white, black ink, 2 px black line under the header. Note A (peach, see-through) painted solid white; its highlight and red text shown as plain black text. Note B keeps its own font and size (Amiri 20). |
| High contrast off, Compact, default font DejaVu Serif, size 18 | Note A in DejaVu Serif at 16.2 px (18 × 0.9), 10 px side padding, 28 px header; peach see-through, highlight and red text back. Note B unchanged: Amiri at 20 px, the title the same width as before. |
| Reset (off, Comfortable, System default, 15) | Both notes as in the first capture; note B's body pixel-identical |
| Notes never written | After all three combinations the note rows are unchanged: colour, `appearance` (`{"opacity": 80}`, `{"font": "Amiri", "fontSize": 20}`) and `updated_at = created_at` |
| Settings kept after a restart | Each combination was read from the settings table at start-up and drawn from the first paint |
| Settings sidebar | "Appearance" second in General · Appearance · Privacy · Backup · About, with the sun icon |

## Not checked in the real app (owner checks)

| Item | Why |
|---|---|
| The Appearance pane controls in the real window: the switch, Compact/Comfortable, the font list, the size stepper, Reset appearance, and an error on a refused save | Clicks did not reach the Settings window. The pane is covered by unit tests through the Settings window, including the save queue and revert on failure, and was checked in the browser preview in light and dark. |
| The live change reaching open notes without a restart (`app-appearance-changed`) | Needs the pane. Unit tests cover the event, the listener and the note re-styling. |
| High contrast with a dark system theme: "Move to trash", the link error, selected text, keyboard focus rings | Needs menus, selection and keyboard. Covered by stylesheet tests and the preview with a dark theme. |
| Note settings showing "Amiri (default)" when a default font is set | Needs the Note settings window. Covered by unit tests. |
| A flash of the lemon loading colour when a note opens in high contrast | Not seen in the captures, which were taken after start-up. A note opened while the app is running was not watched. |

## Automated tests at the end of the branch

513 frontend tests, `cargo test --workspace`, `cargo clippy -D warnings`, `npm run lint` and `npm run typecheck` all pass.
Each task was reviewed separately, then the whole branch; findings were fixed and re-reviewed.

## DES-35 batch 1: high contrast polish and behaviour (2026-11-09)

Debug build of `fix/des-35-appearance`, hidden X display, scratch HOME. High contrast was
switched on in the throwaway database, which also held a read-only blue note with inline code
and a rolled-up peach note.

| Check | Result |
|---|---|
| Read-only chip | White with a black edge (was a grey tint) |
| Inline code | Black outline on white |
| Rolled-up strip | Black 2 px edge on white |

Owner decisions (2026-11-09): a note's font or size equal to the app default means "follow
the app", for both (before, only the size did). A per-note "System font" while an app default
font is set is not wanted for now.

Not checked in the real app: the first frame in high contrast (it lasts one frame), the
Forgot-PIN accent button under a dark system theme, and the link tooltip. These are covered
by unit tests and the stylesheet test.

## DES-35 batch 2: code and test tidy-ups (2026-11-09)

No visible change was intended: the note window was split into smaller files and the
appearance setter and tests were tidied. Debug build of `refactor/des-35-tidy`, hidden X
display, scratch HOME. The throwaway database had a PIN set (so the lock was on at start),
the Compact layout, two private notes (one rolled up) and a plain note with its own 20 px size.

| Check | Result |
|---|---|
| Locked private note | Its label "Bank" and the PIN pad; no note text |
| Rolled-up private note | A 32 px strip with its label "Diary" |
| Expand, then collapse, the private note | 320 × 300 with the PIN pad and no text, then back to the 32 px strip |
| Plain note | Its own 20 px text; Compact 28 px header |
| App log | Only the usual Xvfb graphics warnings |

943 frontend tests, `cargo test --workspace`, `cargo clippy -D warnings`, eslint and
typecheck pass. (Plain `npm run lint` fails in a checkout that holds Claude worktrees under
`.claude/worktrees/`; eslint run with `--ignore-pattern '.claude/**'` is clean.)

One full frontend run had a failing test. Running three suites at once reproduced it: every
failure was a slow test passing vitest's 5 s limit (5.3–5.9 s), never a wrong result. The
tests that went over were "renders the saved rich text with the note colour", "Private opens
Make private in place…" (NoteWindow) and "says the note is marked done…" (DoneStrip). Alone,
the suite passes every time (four runs in a row).
