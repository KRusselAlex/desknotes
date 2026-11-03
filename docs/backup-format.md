# DeskNotes backup format (version 2)

A backup is one UTF-8 JSON file, usually named `desknotes-YYYY-MM-DD.json`. It holds
every note — active, archived and in the trash — with its window state and whether it
is private. It holds no settings, no PIN and no recovery code. The same file works on every operating system.

```json
{
  "format": "desknotes-backup",
  "version": 2,
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
      "editLocked": false,
      "private": true,
      "privateLabel": "Bank",
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
- `private` (optional, default `false`) marks a note hidden behind the privacy lock.
  `privateLabel` (optional, default `""`) is the neutral name shown while it is locked:
  trimmed, at most 40 characters, no control characters. The label is kept when a note
  is no longer private. A backup is **not** encrypted: private notes are stored in it as
  plain text, like every other note.

## Versions

| Version | Changes |
|---|---|
| 1 | First format. |
| 2 | Adds the optional `private` and `privateLabel` fields per note. |

DeskNotes writes version 2 and still restores version 1 files; their notes come back
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
4. Notes are replaced in a single transaction, then visible notes reopen.

A file with a higher `version` than the app supports is refused ("made by a newer
DeskNotes"). Notes whose stored content is damaged are left out of an export, and the
export says how many.
