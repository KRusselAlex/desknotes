# DeskNotes backup format (version 6)

A backup is one UTF-8 JSON file, usually named `desknotes-YYYY-MM-DD.json`. It holds
every note — active, archived and in the trash — with its window state, its text and
window styling, whether it is private, its reminder, when it was marked done, and the images its text uses. It holds no settings, no PIN and no recovery code. The same file works on every operating system.

```json
{
  "format": "desknotes-backup",
  "version": 6,
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
  ],
  "images": [
    {
      "id": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "mime": "image/png",
      "width": 640,
      "height": 480,
      "data": "iVBORw0KGgo… (standard base64)"
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

- `images` (optional, default `[]`) holds the pictures the notes use, each once, whether the
  note is active, archived or in the trash. A note refers to an image with an `image` node
  whose `id` is the image's `id`. Each entry has:
  - `id`: 64 lowercase hex characters, the SHA-256 of the image bytes;
  - `mime`: `image/png`, `image/jpeg`, `image/gif` or `image/webp`;
  - `width` and `height`: whole pixels, 1 to 65535;
  - `data`: the image bytes exactly as DeskNotes stores them (already shrunk, with no
    metadata), as standard base64 with padding.

  Images nobody uses are not written. On restore every image is checked: the `mime` must
  be one of the four and match the first bytes of the data (the file's own claim is never
  trusted), the decoded data is at most 5 MB (`5 * 1024 * 1024` bytes), the base64 must be
  valid, the SHA-256 of the bytes must equal `id`, and an `id` must not appear twice. Any
  failure refuses the whole file, and nothing changes (the error says which image). The
  bytes are not re-encoded, so ids stay the same. An image in the file that no note uses
  is skipped, not stored. A note that refers to an image the file does not hold still
  restores, with the image node in its text; the editor shows "Image not found" there.
  Unknown keys in an image refuse the whole file.

- A backup file can be at most 300 MiB (`300 * 1024 * 1024` bytes). Export is refused,
  before anything is written, with "This backup would be over 300 MB. Remove some images
  and try again." when the file would be larger; restore refuses a larger file as too large.

## Versions

| Version | Changes |
|---|---|
| 1 | First format. |
| 2 | Adds the optional `private` and `privateLabel` fields per note. |
| 3 | Adds the optional `appearance` object per note. |
| 4 | Adds the optional `reminder` object per note. |
| 5 | Adds the optional `completedAt` per note (when it was marked done). |
| 6 | Adds the optional top-level `images` list (the pictures notes use, as base64), and raises the file limit from 200 MiB to 300 MiB. |

DeskNotes writes version 6 and still restores version 1 to 5 files; files before version 6
have no images, so a note that has an `image` node comes back with the "Image not found"
placeholder. Their notes come back not done (before version 5), version 1, 2 and 3 notes
without reminders, version 1 and 2 notes with default appearance, and version 1 notes also
not private, with an empty label.

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
4. Notes are replaced in a single transaction, then visible notes reopen. The file's
   images are stored in that same transaction, before the notes, so the notes' image
   references are recorded; images already in the database but used by no restored note
   are removed by the clean-up at the next start-up.

A file with a higher `version` than the app supports is refused ("made by a newer
DeskNotes"). Notes whose stored content is damaged are left out of an export, and the
export says how many.
