"""Print notes and window geometry from a DeskNotes database (read-only)."""
import sqlite3, sys, json
con = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
cols = [c[1] for c in con.execute("PRAGMA table_info(note_windows)")]
if "collapsed" not in cols:
    raise SystemExit("database is older than migration 3")
for row in con.execute("SELECT n.id, n.title, n.color, n.edit_locked, w.x, w.y, w.width, w.height, w.visible, w.always_on_top AS on_top, w.collapsed, substr(n.content_json,1,120) FROM notes n JOIN note_windows w ON w.note_id=n.id ORDER BY n.created_at"):
    print(row)
