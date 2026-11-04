//! Desktop notifications for reminders (spec §3.3, §5): the freedesktop Desktop
//! Notifications service (`org.freedesktop.Notifications`) on the local session bus,
//! through zbus, which is already in the build. No network, no new crate.
//!
//! One connection is opened at the first notification and kept for the life of the
//! app: GNOME removes a notification once the connection that sent it closes. A single
//! listener thread on that connection reports `ActionInvoked` and `NotificationClosed`.
//!
//! This module only shows what it is given and reports what the person did. It never
//! logs a notification's text; its errors carry only a D-Bus error name or a kind.

use std::fmt;

/// A notification to show. `summary` is the only text: there is no body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification<'a> {
    pub summary: &'a str,
    /// (key, label) pairs. The key "default" (label "") is a click on the notification.
    pub actions: &'a [(&'a str, &'a str)],
}

/// What the person did with a notification, as the service reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// A button (its key) or the notification itself ("default") was clicked.
    Action { id: u32, key: String },
    /// The notification went away, with or without an action.
    Closed { id: u32 },
}

/// Why a notification could not be shown. Never contains the notification's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyError(pub String);

impl fmt::Display for NotifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Shown as the notification's application name.
pub const APP_NAME: &str = "DeskNotes";
/// The icon name of the installed desktop entry (`Icon=desknotes`).
pub const APP_ICON: &str = "desknotes";
/// The installed desktop entry (`DeskNotes.desktop`), so GNOME files the notifications
/// under DeskNotes.
pub const DESKTOP_ENTRY: &str = "DeskNotes";

pub use imp::Notifier;

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use zbus::blocking::{Connection, MessageIterator};
    use zbus::message::Type;
    use zbus::zvariant::Value;
    use zbus::{MatchRule, Message};

    use super::{APP_ICON, APP_NAME, DESKTOP_ENTRY, Notification, NotifyError, Signal};

    const SERVICE: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    /// Let the service decide how long a notification stays on screen.
    const DEFAULT_EXPIRY: i32 = -1;
    /// `replaces_id` 0: always a new notification, so each reminder gets its own banner.
    const NEW_NOTIFICATION: u32 = 0;
    /// Desktop Notifications urgency "normal".
    const NORMAL_URGENCY: u8 = 1;

    type OnSignal = Arc<dyn Fn(Signal) + Send + Sync>;

    pub struct Notifier {
        connection: Mutex<Option<Connection>>,
        on_signal: OnSignal,
    }

    impl Notifier {
        /// `on_signal` runs on the listener thread for every action and close.
        pub fn new(on_signal: impl Fn(Signal) + Send + Sync + 'static) -> Self {
            Self {
                connection: Mutex::new(None),
                on_signal: Arc::new(on_signal),
            }
        }

        /// Show `n` and return its id. Blocks until the service answers (zbus' default
        /// call timeout bounds it), so call it from a background thread.
        pub fn send(&self, n: &Notification<'_>) -> Result<u32, NotifyError> {
            let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(connect(self.on_signal.clone()).map_err(|e| error_kind(&e))?);
            }
            let Some(conn) = guard.as_ref() else {
                return Err(NotifyError("no connection".into()));
            };
            let actions: Vec<&str> = n.actions.iter().flat_map(|(k, l)| [*k, *l]).collect();
            let mut hints: HashMap<&str, Value<'_>> = HashMap::new();
            hints.insert("desktop-entry", Value::from(DESKTOP_ENTRY));
            hints.insert("urgency", Value::from(NORMAL_URGENCY));
            let reply = conn.call_method(
                Some(SERVICE),
                PATH,
                Some(SERVICE),
                "Notify",
                &(
                    APP_NAME,
                    NEW_NOTIFICATION,
                    APP_ICON,
                    n.summary,
                    "",
                    actions,
                    hints,
                    DEFAULT_EXPIRY,
                ),
            );
            match reply.and_then(|m| m.body().deserialize::<u32>()) {
                Ok(id) => Ok(id),
                Err(e) => {
                    // A refusal by the service keeps the connection; anything else may
                    // mean the connection is gone, so the next send opens a new one.
                    if !matches!(e, zbus::Error::MethodError(..)) {
                        *guard = None;
                    }
                    Err(error_kind(&e))
                }
            }
        }
    }

    /// Open the session bus and start the listener for this connection's signals.
    fn connect(on_signal: OnSignal) -> zbus::Result<Connection> {
        let conn = Connection::session()?;
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(SERVICE)?
            .interface(SERVICE)?
            .path(PATH)?
            .build();
        let messages = MessageIterator::for_match_rule(rule, &conn, None)?;
        std::thread::Builder::new()
            .name("desknotes-notifications".into())
            .spawn(move || {
                for message in messages.flatten() {
                    if let Some(signal) = parse_signal(&message) {
                        on_signal(signal);
                    }
                }
            })
            .map_err(|e| zbus::Error::Failure(format!("listener thread: {e}")))?;
        Ok(conn)
    }

    fn parse_signal(message: &Message) -> Option<Signal> {
        let header = message.header();
        match header.member()?.as_str() {
            "ActionInvoked" => {
                let (id, key) = message.body().deserialize::<(u32, String)>().ok()?;
                Some(Signal::Action { id, key })
            }
            "NotificationClosed" => {
                let (id, _reason) = message.body().deserialize::<(u32, u32)>().ok()?;
                Some(Signal::Closed { id })
            }
            _ => None,
        }
    }

    /// A short description of the failure that cannot carry the notification's text:
    /// the D-Bus error name, or the kind of failure.
    pub(super) fn error_kind(e: &zbus::Error) -> NotifyError {
        let kind = match e {
            zbus::Error::MethodError(name, _, _) => return NotifyError(name.to_string()),
            zbus::Error::FDO(fdo) => return NotifyError(fdo_name(fdo)),
            zbus::Error::InputOutput(_) => "the session bus is unavailable",
            zbus::Error::Address(_) => "no session bus address",
            zbus::Error::Variant(_) => "unexpected reply",
            _ => "D-Bus error",
        };
        NotifyError(kind.into())
    }

    fn fdo_name(e: &zbus::fdo::Error) -> String {
        use zbus::DBusError;
        e.name().to_string()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn errors_name_the_kind_only() {
            let e = zbus::Error::Failure("Shopping list".into());
            assert_eq!(error_kind(&e).0, "D-Bus error");
            let e = zbus::Error::FDO(Box::new(zbus::fdo::Error::ServiceUnknown(
                "Shopping list".into(),
            )));
            assert_eq!(
                error_kind(&e).0,
                "org.freedesktop.DBus.Error.ServiceUnknown"
            );
        }

        /// Shows one real notification on this desktop's session bus, then closes it.
        /// Run by hand: `cargo test -p desknotes real_notification -- --ignored --nocapture`.
        #[test]
        #[ignore = "needs a desktop session with a notification service"]
        fn real_notification() {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            let notifier = Notifier::new(move |s| log.lock().unwrap().push(s));
            let id = notifier
                .send(&Notification {
                    summary: "DeskNotes test reminder",
                    actions: &[
                        ("snooze10", "10 min"),
                        ("snooze60", "1 h"),
                        ("tomorrow", "Tomorrow"),
                        ("dismiss", "Dismiss"),
                        ("default", ""),
                    ],
                })
                .expect("notification sent");
            assert!(id > 0);
            println!("notification id {id}; waiting 8 s for a click");
            std::thread::sleep(std::time::Duration::from_secs(8));
            let guard = notifier.connection.lock().unwrap();
            let conn = guard.as_ref().unwrap();
            let _ = conn.call_method(
                Some(SERVICE),
                PATH,
                Some(SERVICE),
                "CloseNotification",
                &(id,),
            );
            std::thread::sleep(std::time::Duration::from_millis(500));
            println!("signals: {:?}", seen.lock().unwrap());
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{Notification, NotifyError, Signal};

    /// Desktop notifications are only implemented on Linux for now.
    pub struct Notifier;

    impl Notifier {
        pub fn new(_on_signal: impl Fn(Signal) + Send + Sync + 'static) -> Self {
            Self
        }

        pub fn send(&self, _n: &Notification<'_>) -> Result<u32, NotifyError> {
            Err(NotifyError("not supported on this system".into()))
        }
    }
}
