# DeskNotes backup format (version 5)

A backup is one UTF-8 JSON file, usually named `desknotes-YYYY-MM-DD.json`. It holds
every note — active, archived and in the trash — with its window state, its text and
window styling, whether it is private, its reminder, and when it was marked done. It holds no settings, no PIN and no recovery code. The same file works on every operating system.

```json
{
  "format": "desknotes-backup",
  "version": 5,
  "appVersion": "0.1.0",
  "exportedAt": 1793520000000,
  "notes": [
    {
      "id": "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d",
      "content": { "type": "doc", "content": [ … Tiptap/ProseMirror JSON … ] },
      "color": "#fff4a3",
      "createdAt": 1793510000000,
      "updatedAt": 1793519000000,
      "archivedAt": null,
      "deletedAt": null,
      "completedAt": null,
      "editLocked": false,
      "private": true,
      "privateLabel": "Bank",
      "appearance": { "fontSize": 18, "textColor": "#1d4f91", "opacity": 90 },
      "reminder": { "localDate": "2026-11-04", "localTime": "14:00", "repeat": "weekdays",
                    "dueAt": 1793797200000, "snoozedUntil": null, "firedAt": null },
      "window": { "x": 130, "y": 96, "width": 300, "height": 280,
                  "visible": true, "alwaysOnTop": false, "collapsed": false }
    }
  ]
}
```

- Times are Unix milliseconds in UTC.
- `x`/`y` are logical pixels and may be `null` (the note is placed automatically).
- `content` follows the same rules as notes in the app: node and mark allowlist, links
  limited to `http`, `https` and `mailto`, at most 1 MiB per note.
  Content may also contain the `textStyle` mark (optional `fontFamily`, `fontSize` from
  `10px` to `32px`, `fontWeight` `300`/`400`/`500`/`600`, and `color` from the six text
  colours), the `highlight` mark (`color` from the four highlight colours) and a `textAlign`
  of `left`, `center` or `right` on paragraphs and headings. The format number stays 3.
- `private` (optional, default `false`) marks a note hidden behind the privacy lock.
  `privateLabel` (optional, default `""`) is the neutral name shown while it is locked:
  trimmed, at most 40 characters, no control characters. The label is kept when a note
  is no longer private. A backup is **not** encrypted: private notes are stored in it as
  plain text, like every other note.
- `appearance` (optional, default `{}`) is the note's own styling. Every key is optional
  and a missing key means the default: `font` (a font family name, trimmed, at most 100
  characters, never CSS), `fontSize` (10 to 32 px), `textColor` (one of `#201e1d`,
  `#8c491a`, `#56633f`, `#1d4f91`; upper case is accepted and lower-cased),
  `lineSpacing` (100 to 200 percent, steps of 5), `direction` (`auto`, `ltr` or `rtl`)
  and `opacity` (80 to 100 percent, steps of 5). Unknown keys and out-of-range values
  refuse the whole file (an out-of-range value names the note). The background colour is the note's `color`.

- `reminder` (optional, default `null` = no reminder) is the note's one reminder. A note
  in the trash keeps its reminder. `localDate` (`YYYY-MM-DD`, a real calendar date),
  `localTime` (`HH:MM`, 24 h) and `repeat` (`none`, `daily`, `weekdays`, `weekly` or
  `monthly`) are the wall-clock choice the user made; they stay the same in any time
  zone. `dueAt` is the next occurrence and `snoozedUntil` (optional) the snoozed time, both
  Unix ms in UTC; `firedAt` (optional) is the due time already notified, so a restored
  reminder is not notified twice. Every time must be 0 or more and within 100 years of
  the day of the restore, `repeat` must be one of the five names, and unknown keys refuse
  the whole file (the error names the note). A reminder DeskNotes cannot read back from
  its own database is left out of an export.

- `completedAt` (optional, default `null` = not done) is when the note was marked done,
  Unix ms in UTC, 0 or more. A note keeps its `completedAt` while it is archived or in the
  trash; it appears in the Completed list only when it is neither. A negative value
  refuses the whole file (the error names the note).

## Versions

| Version | Changes |
|---|---|
| 1 | First format. |
| 2 | Adds the optional `private` and `privateLabel` fields per note. |
| 3 | Adds the optional `appearance` object per note. |
| 4 | Adds the optional `reminder` object per note. |
| 5 | Adds the optional `completedAt` per note (when it was marked done). |

DeskNotes writes version 5 and still restores version 1, 2, 3 and 4 files; their notes come
back not done, version 1, 2 and 3 notes without reminders, version 1 and 2 notes with default appearance, and version 1
notes also not private, with an empty label.

## Exporting

While the privacy lock is on and any private note exists (active, archived or in the
trash), export is refused until the PIN is entered.

## Restoring

Restore replaces **all** notes with the notes in the file, after confirmation:

1. Every open note is asked to save; restore is refused if one cannot. While the
   privacy lock is on and any private note exists, restore is refused until the PIN is
   entered, before anything is written.
2. The whole file is validated first. If anything is wrong, nothing changes.
3. A copy of the current database is written to `backups/pre-restore-<time>.db` in the
   data folder.
4. Notes are replaced in a single transaction, then visible notes reopen.

A file with a higher `version` than the app supports is refused ("made by a newer
DeskNotes"). Notes whose stored content is damaged are left out of an export, and the
export says how many.
