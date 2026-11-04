//! Automatic locking of private notes (design D3, §4.3).
//!
//! Three things lock the notes without the person asking: the computer going
//! to sleep, the screen locking, and no input in any DeskNotes window for the
//! chosen time. The first two are D-Bus signals on Linux; this module only
//! listens for them and calls `on_lock`. It never decides whether a lock is
//! needed (no PIN, already locked) and never blocks the app: every listener
//! runs on its own thread, and a missing bus or service is logged once on
//! stderr and otherwise ignored.

use std::time::Duration;

/// How often the inactivity check runs.
pub const INACTIVITY_CHECK_EVERY: Duration = Duration::from_secs(30);

/// Whether `minutes` have passed since the last input. A clock that moved back
/// (`now_ms` before `last_ms`) never counts as inactivity.
pub fn inactive_long_enough(now_ms: i64, last_ms: i64, minutes: u32) -> bool {
    now_ms
        .checked_sub(last_ms)
        .is_some_and(|idle| idle >= 0 && idle >= i64::from(minutes) * 60_000)
}

/// Run `tick` every [`INACTIVITY_CHECK_EVERY`] on its own thread.
pub fn watch_inactivity(tick: impl Fn() + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name("desknotes-inactivity".into())
        .spawn(move || {
            loop {
                std::thread::sleep(INACTIVITY_CHECK_EVERY);
                tick();
            }
        });
    if let Err(e) = spawned {
        eprintln!("DeskNotes: the inactivity lock could not start: {e}");
    }
}

/// Listen for sleep and screen-lock signals and call `on_lock` for each, and
/// `on_resume` when the computer wakes from sleep (the reminder scheduler's timer
/// does not count the time asleep). Both run on a listener thread; `on_lock` may
/// block (it waits for the note windows to save); several signals for one event
/// are the caller's to merge. Only Linux has listeners; elsewhere this does nothing.
pub fn watch(
    on_lock: impl Fn() + Send + Sync + Clone + 'static,
    on_resume: impl Fn() + Send + 'static,
) {
    #[cfg(target_os = "linux")]
    linux::watch(on_lock, on_resume);
    #[cfg(not(target_os = "linux"))]
    let _ = (on_lock, on_resume);
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::atomic::{AtomicBool, Ordering};

    use zbus::blocking::proxy::Builder;
    use zbus::blocking::{Connection, Proxy};
    use zbus::proxy::CacheProperties;
    use zbus::zvariant::{OwnedFd, OwnedObjectPath};

    const LOGIND: &str = "org.freedesktop.login1";
    const LOGIND_PATH: &str = "/org/freedesktop/login1";
    const LOGIND_MANAGER: &str = "org.freedesktop.login1.Manager";
    const LOGIND_SESSION: &str = "org.freedesktop.login1.Session";
    const LOGIND_USER: &str = "org.freedesktop.login1.User";
    const SCREEN_SAVER: &str = "org.gnome.ScreenSaver";
    const SCREEN_SAVER_PATH: &str = "/org/gnome/ScreenSaver";

    pub fn watch(
        on_lock: impl Fn() + Send + Sync + Clone + 'static,
        on_resume: impl Fn() + Send + 'static,
    ) {
        let sleep = on_lock.clone();
        let screen = on_lock.clone();
        let session = on_lock;
        spawn("sleep", move || watch_sleep(&sleep, &on_resume));
        spawn("screen-saver", move || watch_screen_saver(&screen));
        spawn("session-lock", move || watch_session_lock(&session));
    }

    /// Run a listener on its own thread; a failure is logged once and ends it.
    fn spawn(what: &'static str, run: impl FnOnce() -> zbus::Result<()> + Send + 'static) {
        let spawned = std::thread::Builder::new()
            .name(format!("desknotes-{what}"))
            .spawn(move || {
                if let Err(e) = run() {
                    eprintln!("DeskNotes: automatic lock on {what} is unavailable: {e}");
                }
            });
        if let Err(e) = spawned {
            eprintln!("DeskNotes: automatic lock on {what} could not start: {e}");
        }
    }

    fn proxy<'a>(
        conn: &Connection,
        destination: &'static str,
        path: impl TryInto<zbus::zvariant::ObjectPath<'a>, Error = impl Into<zbus::Error>>,
        interface: &'static str,
    ) -> zbus::Result<Proxy<'a>> {
        Builder::new(conn)
            .destination(destination)?
            .path(path)?
            .interface(interface)?
            .cache_properties(CacheProperties::No)
            .build()
    }

    /// The boolean argument of a signal, or `None` when it is something else.
    fn flag(message: &zbus::Message) -> Option<bool> {
        message.body().deserialize::<bool>().ok()
    }

    /// A "delay" inhibitor makes logind wait (a few seconds) for DeskNotes
    /// before sleeping, so the save and lock can finish. Not having one only
    /// means the lock may race the sleep, so the failure is logged once.
    fn take_inhibitor(manager: &Proxy<'_>) -> Option<OwnedFd> {
        static LOGGED: AtomicBool = AtomicBool::new(false);
        match manager.call::<_, _, OwnedFd>(
            "Inhibit",
            &(
                "sleep",
                "DeskNotes",
                "Locking private notes before sleep",
                "delay",
            ),
        ) {
            Ok(fd) => Some(fd),
            Err(e) => {
                if !LOGGED.swap(true, Ordering::Relaxed) {
                    eprintln!("DeskNotes: could not delay sleep to lock notes: {e}");
                }
                None
            }
        }
    }

    /// logind `PrepareForSleep(true)` on the system bus; `PrepareForSleep(false)`
    /// is the resume.
    fn watch_sleep(on_lock: &dyn Fn(), on_resume: &dyn Fn()) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let manager = proxy(&conn, LOGIND, LOGIND_PATH, LOGIND_MANAGER)?;
        let mut inhibitor = take_inhibitor(&manager);
        for message in manager.receive_signal("PrepareForSleep")? {
            match flag(&message) {
                Some(true) => {
                    on_lock();
                    // Let the computer sleep; the next inhibitor waits for resume.
                    inhibitor = None;
                }
                Some(false) => {
                    inhibitor = take_inhibitor(&manager);
                    on_resume();
                }
                None => {}
            }
        }
        drop(inhibitor);
        Ok(())
    }

    /// GNOME `org.gnome.ScreenSaver.ActiveChanged(true)` on the session bus.
    /// Without GNOME's service the signal never comes; that is not an error.
    fn watch_screen_saver(on_lock: &dyn Fn()) -> zbus::Result<()> {
        let conn = Connection::session()?;
        let saver = proxy(&conn, SCREEN_SAVER, SCREEN_SAVER_PATH, SCREEN_SAVER)?;
        for message in saver.receive_signal("ActiveChanged")? {
            if flag(&message) == Some(true) {
                on_lock();
            }
        }
        Ok(())
    }

    /// The logind object of this login session. A process started from the
    /// desktop runs in the user's app scope, not the session's, so `GetSessionByPID`
    /// fails for it; then the user's graphical session (`User.Display`) is used.
    fn session_path(conn: &Connection, manager: &Proxy<'_>) -> zbus::Result<OwnedObjectPath> {
        let pid = (std::process::id(),);
        let by_pid = match manager.call::<_, _, OwnedObjectPath>("GetSessionByPID", &pid) {
            Ok(path) => return Ok(path),
            Err(e) => e,
        };
        if let Ok(id) = std::env::var("XDG_SESSION_ID")
            && let Ok(path) = manager.call::<_, _, OwnedObjectPath>("GetSession", &(id,))
        {
            return Ok(path);
        }
        let user: OwnedObjectPath = manager.call("GetUserByPID", &pid).map_err(|_| by_pid)?;
        let user = proxy(conn, LOGIND, user.as_str().to_owned(), LOGIND_USER)?;
        let (_id, path): (String, OwnedObjectPath) = user.get_property("Display")?;
        Ok(path)
    }

    /// Fallback for desktops without the GNOME service: logind's `Lock` signal
    /// on this session (what `loginctl lock-session` sends).
    fn watch_session_lock(on_lock: &dyn Fn()) -> zbus::Result<()> {
        let conn = Connection::system()?;
        let manager = proxy(&conn, LOGIND, LOGIND_PATH, LOGIND_MANAGER)?;
        let path = session_path(&conn, &manager)?;
        let session = proxy(&conn, LOGIND, path.as_str().to_owned(), LOGIND_SESSION)?;
        for _ in session.receive_signal("Lock")? {
            on_lock();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIVE: u32 = 5;

    #[test]
    fn inactivity_is_measured_in_whole_minutes() {
        let last = 1_000_000;
        assert!(!inactive_long_enough(
            last + 4 * 60_000 + 59_000,
            last,
            FIVE
        ));
        assert!(inactive_long_enough(last + 5 * 60_000, last, FIVE));
        assert!(inactive_long_enough(last + 60 * 60_000, last, FIVE));
        assert!(!inactive_long_enough(last, last, FIVE));
    }

    #[test]
    fn a_clock_moved_back_is_not_inactivity() {
        assert!(!inactive_long_enough(1_000, 9_000_000, FIVE));
        assert!(!inactive_long_enough(i64::MIN, i64::MAX, FIVE));
    }
}
