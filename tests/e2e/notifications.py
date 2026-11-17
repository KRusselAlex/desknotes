"""A stand-in for the desktop's notification service, for the end-to-end tests.

It owns org.freedesktop.Notifications on the tests' private D-Bus session (never the
desktop's: scripts/e2e/run.sh starts that bus) and records what DeskNotes sends.

Output, one JSON object per line on stdout:
  {"event": "ready"}                       once the name is owned
  {"event": "notify", "id": 1, ...}        each Notify call, with every argument
  {"event": "close", "id": 1}              each CloseNotification call
Input, one JSON object per line on stdin:
  {"invoke": 1, "key": "default"}          the person clicks a button ("default": the
                                           notification itself): ActionInvoked, then
                                           NotificationClosed (reason 2), as GNOME does
It exits when stdin closes. Needs python3-gi (GLib and Gio).
"""
import json
import os
import sys

from gi.repository import Gio, GLib

NAME = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
XML = f"""<node><interface name="{NAME}">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="Notify">
    <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
    <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
    <arg type="a{{sv}}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
  </method>
  <method name="CloseNotification"><arg type="u" direction="in"/></method>
  <method name="GetServerInformation">
    <arg type="s" direction="out"/><arg type="s" direction="out"/>
    <arg type="s" direction="out"/><arg type="s" direction="out"/>
  </method>
  <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
  <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>"""
REASON_DISMISSED = 2

# Only on the tests' private bus: scripts/e2e/run.sh sets these, with the runtime folder
# (where the private bus lives) inside the scratch folder. On a desktop whose own
# service starts on demand, this would otherwise take the name and read others' notifications.
scratch = os.environ.get("DESKNOTES_E2E_TMP")
if not scratch or not os.environ.get("XDG_RUNTIME_DIR", "").startswith(scratch + "/"):
    sys.exit("Run through `npm run test:e2e` (scripts/e2e/run.sh) only.")

loop = GLib.MainLoop()
connection = None
next_id = 0


def emit(event):
    print(json.dumps(event, default=str), flush=True)


def on_call(conn, sender, path, iface, method, params, invocation):
    global next_id
    if method == "Notify":
        app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
        next_id += 1
        nid = replaces or next_id
        emit({"event": "notify", "id": nid, "app": app, "replaces": replaces, "icon": icon,
              "summary": summary, "body": body,
              "actions": [actions[i:i + 2] for i in range(0, len(actions), 2)],
              "hints": hints, "timeout": timeout})
        invocation.return_value(GLib.Variant("(u)", (nid,)))
    elif method == "CloseNotification":
        (nid,) = params.unpack()
        emit({"event": "close", "id": nid})
        invocation.return_value(None)
    elif method == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
    elif method == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("desknotes-e2e", "DeskNotes", "1", "1.2")))


def signal(name, args, signature):
    connection.emit_signal(None, PATH, NAME, name, GLib.Variant(signature, args))


def on_stdin(channel, condition):
    line = channel.readline()
    if not line:
        loop.quit()
        return False
    command = json.loads(line)
    nid = command["invoke"]
    signal("ActionInvoked", (nid, command["key"]), "(us)")
    signal("NotificationClosed", (nid, REASON_DISMISSED), "(uu)")
    return True


def on_bus(conn, name):
    global connection
    connection = conn
    conn.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], on_call, None, None)


def on_name(conn, name):
    emit({"event": "ready"})


def on_lost(conn, name):
    print(f"could not own {NAME}", file=sys.stderr, flush=True)
    os._exit(1)


Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.DO_NOT_QUEUE, on_bus, on_name, on_lost)
GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT,
                  GLib.IOCondition.IN | GLib.IOCondition.HUP, on_stdin)
loop.run()
