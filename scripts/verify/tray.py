"""Drive DeskNotes' tray menu over D-Bus, the way the desktop shell does.

Usage: tray.py list            show the menu items of the running DeskNotes
       tray.py click LABEL     activate the item with that label
Needs gdbus (part of GLib, present on GNOME desktops).
"""
import re, subprocess, sys, time

def gdbus(*args):
    return subprocess.run(["gdbus", "call", "--session", *args], capture_output=True, text=True).stdout

def our_item():
    pid = subprocess.run(["pgrep", "-x", "desknotes"], capture_output=True, text=True).stdout.split()
    if not pid:
        sys.exit("DeskNotes is not running")
    items = re.findall(r"'([^']+)'", gdbus("--dest", "org.kde.StatusNotifierWatcher", "--object-path",
        "/StatusNotifierWatcher", "--method", "org.freedesktop.DBus.Properties.Get",
        "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"))
    for item in items:
        if "@" in item:  # ":1.352@/org/ayatana/NotificationItem/..."
            bus, _, obj = item.partition("@")
        else:  # a bare bus name; the item lives at the standard path
            bus, obj = item, "/StatusNotifierItem"
        owner = re.findall(r"uint32 (\d+)", gdbus("--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
            "--method", "org.freedesktop.DBus.GetConnectionUnixProcessID", bus))
        if owner and owner[0] in pid:
            menu = re.search(r"objectpath '([^']+)'", gdbus("--dest", bus, "--object-path", obj, "--method",
                "org.freedesktop.DBus.Properties.Get", "org.kde.StatusNotifierItem", "Menu"))
            return bus, obj, menu.group(1) if menu else None
    sys.exit("no tray item belongs to DeskNotes")

def items(bus, menu):
    layout = gdbus("--dest", bus, "--object-path", menu, "--method", "com.canonical.dbusmenu.GetLayout", "--", "0", "-1", "[]")
    return re.findall(r"\((\d+), \{[^}]*'label': <'([^']*)'>", layout)

bus, obj, menu = our_item()
if sys.argv[1:2] == ["list"]:
    print(f"item {bus}{obj}, menu {menu}")
    for i, label in items(bus, menu):
        print(i, label)
elif sys.argv[1:2] == ["click"]:
    wanted = sys.argv[2]
    for i, label in items(bus, menu):
        if label.replace("_", "") == wanted:
            gdbus("--dest", bus, "--object-path", menu, "--method", "com.canonical.dbusmenu.Event", "--",
                  i, "clicked", "<0>", str(int(time.time())))
            print("clicked", label)
            break
    else:
        sys.exit(f"no item labelled {wanted!r}")
