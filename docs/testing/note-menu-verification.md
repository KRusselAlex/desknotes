# Note ⋯ menu (option B) — verification on Ubuntu

Date: 2026-11-05 · Branch: `feat/note-menu` (fe078b6) · Jira: DES-38
Design: `docs/superpowers/specs/2026-11-05-note-menu-design.md` (option B, chosen by the owner in chat)

## Machine and conditions

| Item | Value |
|---|---|
| OS | Ubuntu 24.04.5 LTS, GNOME 46 on Wayland; DeskNotes through XWayland (ADR-0002) |
| Build | Release binary (`npm run tauri build -- --no-bundle`) |
| Data | Isolated scratch folder. The owner's DeskNotes was quit with their agreement and restarted afterwards. |
| Method | Clicks with libxdo (`scripts/verify/x.py`) and window screenshots |

## Checked in the real app

| Check | Result |
|---|---|
| Opening ⋯ on a 300 × 280 note | The new menu opens inside the note. The quick row New, Duplicate, On top and Lock is first, with icons and full labels. Then a separator, Set reminder…, Note settings…, Private with its chevron, Open manager, a separator, Archive and Move to trash (red). All of it fits inside the window. |

## Not verified in the real app (owner check before merge)

| Item | Why |
|---|---|
| Clicking inside the menu: the On top and Lock toggles (shading, menu stays open), Duplicate, New, the Private sub-list, Note settings… | Simulated clicks inside the open menu did nothing in this session. Even "Note settings…" didn't open, though its code path is unchanged from main. At the same time, text the controller didn't type ("uù") appeared in the scratch note, so the owner was likely using the keyboard and mouse. The run was stopped so it wouldn't interfere. It isn't settled whether the clicks were lost or the menu doesn't respond under WebKitGTK. Unit tests (607) and the Chromium preview show every click and key working. |
| Keyboard map, high contrast, dark theme, 180 px and the header at 300 px with a reminder | Checked in the Chromium preview and by unit and stylesheet tests only. |

## Automated tests

607 frontend tests, `npm run lint` and `npm run typecheck` all pass. The change was reviewed independently twice: once in full, and once scoped to the fixes.
