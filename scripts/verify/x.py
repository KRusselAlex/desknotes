"""X11 test driver for DeskNotes under XWayland (uses libxdo via ctypes, no extra installs).

Commands: list | click X Y | type TEXT | key SEQ | drag X0 Y0 X1 Y1 | size WID W H
          | wmmove WID X Y | shot WID FILE
Note: synthetic typing assumes a QWERTY keymap; capital letters may differ on AZERTY.
Synthetic header drags do not move windows (the compositor runs the move); use wmmove.
"""
import ctypes, subprocess, sys, time

xdo_lib = ctypes.CDLL("libxdo.so.3")
xdo_lib.xdo_new.restype = ctypes.c_void_p
xdo = ctypes.c_void_p(xdo_lib.xdo_new(None))
CURRENT = ctypes.c_ulong(0)

def windows():
    out = subprocess.run(["xwininfo", "-root", "-tree"], capture_output=True, text=True).stdout
    res = []
    for line in out.splitlines():
        if '"DeskNotes"' in line and '"desknotes"' in line:
            wid = line.split()[0]
            info = subprocess.run(["xwininfo", "-id", wid], capture_output=True, text=True).stdout
            g = {k: int(v) for k, v in (l.split(":")[0].strip().split()[-1:] + [l.split(":")[1].strip()] for l in info.splitlines() if l.strip().startswith(("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")))}
            res.append((wid, g["X"], g["Y"], g["Width"], g["Height"]))
    return res

cmd = sys.argv[1]
if cmd == "list":
    for w in windows():
        print(*w)
elif cmd == "click":
    x, y = int(sys.argv[2]), int(sys.argv[3])
    xdo_lib.xdo_move_mouse(xdo, x, y, 0); time.sleep(0.15)
    xdo_lib.xdo_click_window(xdo, CURRENT, 1); time.sleep(0.3)
elif cmd == "type":
    xdo_lib.xdo_enter_text_window(xdo, CURRENT, sys.argv[2].encode(), ctypes.c_uint(30000)); time.sleep(0.3)
elif cmd == "key":
    xdo_lib.xdo_send_keysequence_window(xdo, CURRENT, sys.argv[2].encode(), ctypes.c_uint(30000)); time.sleep(0.3)
elif cmd == "move":
    xdo_lib.xdo_move_window(xdo, ctypes.c_ulong(int(sys.argv[2], 16)), int(sys.argv[3]), int(sys.argv[4])); time.sleep(0.6)
elif cmd == "size":
    xdo_lib.xdo_set_window_size(xdo, ctypes.c_ulong(int(sys.argv[2], 16)), int(sys.argv[3]), int(sys.argv[4]), 0); time.sleep(0.6)
elif cmd == "shot":
    subprocess.run(["import", "-window", sys.argv[2], sys.argv[3]])
elif cmd == "drag":
    x0, y0, x1, y1 = map(int, sys.argv[2:6])
    xdo_lib.xdo_move_mouse(xdo, x0, y0, 0); time.sleep(0.2)
    xdo_lib.xdo_mouse_down(xdo, CURRENT, 1); time.sleep(0.2)
    for i in range(1, 21):
        xdo_lib.xdo_move_mouse(xdo, x0 + (x1 - x0) * i // 20, y0 + (y1 - y0) * i // 20, 0); time.sleep(0.03)
    time.sleep(0.2)
    xdo_lib.xdo_mouse_up(xdo, CURRENT, 1); time.sleep(0.5)
elif cmd == "wmmove":
    # EWMH _NET_MOVERESIZE_WINDOW, as sent by pagers/wmctrl (source indication 2 = pager).
    X = ctypes.CDLL("libX11.so.6")
    X.XOpenDisplay.restype = ctypes.c_void_p
    X.XInternAtom.restype = ctypes.c_ulong
    X.XDefaultRootWindow.restype = ctypes.c_ulong
    dpy = ctypes.c_void_p(X.XOpenDisplay(None))
    class ClientMessage(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                    ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                    ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]
    class XEvent(ctypes.Union):
        _fields_ = [("xclient", ClientMessage), ("pad", ctypes.c_long * 24)]
    ev = XEvent()
    ev.xclient.type = 33  # ClientMessage
    ev.xclient.send_event = 1
    ev.xclient.window = int(sys.argv[2], 16)
    ev.xclient.message_type = X.XInternAtom(dpy, b"_NET_MOVERESIZE_WINDOW", 0)
    ev.xclient.format = 32
    flags = (1 << 8) | (1 << 9) | (2 << 12)  # x, y set; source = pager
    ev.xclient.l[:] = [flags, int(sys.argv[3]), int(sys.argv[4]), 0, 0]
    root = X.XDefaultRootWindow(dpy)
    mask = (1 << 20) | (1 << 19)  # SubstructureRedirect | SubstructureNotify
    X.XSendEvent(dpy, ctypes.c_ulong(root), 0, ctypes.c_long(mask), ctypes.byref(ev))
    X.XFlush(dpy); time.sleep(0.6)
