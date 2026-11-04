//! Desktop notifications for reminders (spec §3.3, §5): the freedesktop Desktop
//! Notifications service (`org.freedesktop.Notifications`) on the local session bus,
//! through zbus, which is already in the build. No network, no new crate.
//!
//! One connection is opened at the first notification and kept for the life of the
//! app: GNOME removes a notification once the connection that sent it closes. A single
//! listener thread on that connection reports `ActionInvoked` and `NotificationClosed`.
//! Calls time out after [`METHOD_TIMEOUT`]; the connection is replaced only when it is
//! broken, and the old listener then stops.
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

/// How long a call to the notification service may take before it fails.
pub const METHOD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

/// What the scheduler needs from a notification service. The desktop one is
/// [`Notifier`]; tests use a fake.
pub trait Notify: Send + Sync {
    /// Show `n` and return its id. May block up to [`METHOD_TIMEOUT`].
    fn send(&self, n: &Notification<'_>) -> Result<u32, NotifyError>;
    /// Take a shown notification away (`CloseNotification`).
    fn close(&self, id: u32) -> Result<(), NotifyError>;
}

pub use imp::Notifier;

#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    use zbus::blocking::{Connection, MessageIterator};
    use zbus::message::Type;
    use zbus::zvariant::Value;
    use zbus::{MatchRule, Message};

    use super::{
        APP_ICON, APP_NAME, DESKTOP_ENTRY, METHOD_TIMEOUT, Notification, Notify, NotifyError,
        Signal,
    };

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
        /// The open connection and its generation.
        connection: Mutex<Option<(Connection, u64)>>,
        /// The generation of the current connection; a listener of an older one stops.
        generation: Arc<AtomicU64>,
        on_signal: OnSignal,
    }

    impl Notifier {
        /// `on_signal` runs on the listener thread for every action and close.
        pub fn new(on_signal: impl Fn(Signal) + Send + Sync + 'static) -> Self {
            Self {
                connection: Mutex::new(None),
                generation: Arc::new(AtomicU64::new(0)),
                on_signal: Arc::new(on_signal),
            }
        }

        /// The connection (opened on first use) and its generation. The lock is held
        /// only to read or open it, never during a call, so a `close` is not queued
        /// behind a slow `send`.
        fn connection(&self) -> Result<(Connection, u64), NotifyError> {
            let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((conn, generation)) = guard.as_ref() {
                return Ok((conn.clone(), *generation));
            }
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let conn = connect(self.on_signal.clone(), self.generation.clone(), generation)
                .map_err(|e| error_kind(&e))?;
            *guard = Some((conn.clone(), generation));
            Ok((conn, generation))
        }

        /// Call a method of the service. A broken connection is dropped (once, by
        /// generation) so the next call opens a new one; the old listener then stops.
        fn call<B>(&self, method: &str, body: &B) -> Result<Message, NotifyError>
        where
            B: serde::Serialize + zbus::zvariant::DynamicType,
        {
            let (conn, generation) = self.connection()?;
            conn.call_method(Some(SERVICE), PATH, Some(SERVICE), method, body)
                .inspect_err(|e| {
                    if should_reconnect(e) {
                        let mut guard = self.connection.lock().unwrap_or_else(|e| e.into_inner());
                        if guard.as_ref().is_some_and(|(_, g)| *g == generation) {
                            *guard = None;
                            self.generation.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                })
                .map_err(|e| error_kind(&e))
        }
    }

    impl Notify for Notifier {
        fn send(&self, n: &Notification<'_>) -> Result<u32, NotifyError> {
            let actions: Vec<&str> = n.actions.iter().flat_map(|(k, l)| [*k, *l]).collect();
            let mut hints: HashMap<&str, Value<'_>> = HashMap::new();
            hints.insert("desktop-entry", Value::from(DESKTOP_ENTRY));
            hints.insert("urgency", Value::from(NORMAL_URGENCY));
            let reply = self.call(
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
            )?;
            reply
                .body()
                .deserialize::<u32>()
                .map_err(|e| error_kind(&e))
        }

        fn close(&self, id: u32) -> Result<(), NotifyError> {
            self.call("CloseNotification", &(id,)).map(drop)
        }
    }

    /// Whether a failed call means the connection itself is broken. A refusal by the
    /// service, a bad reply or a timeout keeps it: replacing a working connection would
    /// leave its listener (and the notifications it sent) behind.
    pub(super) fn should_reconnect(e: &zbus::Error) -> bool {
        match e {
            zbus::Error::InputOutput(io) => io.kind() != std::io::ErrorKind::TimedOut,
            _ => false,
        }
    }

    /// Open the session bus and start the listener for this connection's signals. The
    /// listener stops (dropping its connection) at the first message after `generation`
    /// moved past `mine`, or when the connection ends.
    fn connect(
        on_signal: OnSignal,
        generation: Arc<AtomicU64>,
        mine: u64,
    ) -> zbus::Result<Connection> {
        let conn = zbus::blocking::connection::Builder::session()?
            .method_timeout(METHOD_TIMEOUT)
            .build()?;
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
                for message in messages {
                    if generation.load(Ordering::Acquire) != mine {
                        break;
                    }
                    if let Ok(message) = message
                        && let Some(signal) = parse_signal(&message)
                    {
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
            zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => {
                "the notification service did not answer"
            }
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
        use std::io;

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
            let e = zbus::Error::InputOutput(Arc::new(io::Error::new(
                io::ErrorKind::TimedOut,
                "Shopping list",
            )));
            assert_eq!(error_kind(&e).0, "the notification service did not answer");
        }

        #[test]
        fn only_a_broken_connection_is_replaced() {
            let io_err = |kind| zbus::Error::InputOutput(Arc::new(io::Error::new(kind, "x")));
            assert!(should_reconnect(&io_err(io::ErrorKind::BrokenPipe)));
            assert!(should_reconnect(&io_err(io::ErrorKind::ConnectionReset)));
            assert!(should_reconnect(&io_err(io::ErrorKind::UnexpectedEof)));
            // A slow service, a refusal or an odd reply keep the working connection.
            assert!(!should_reconnect(&io_err(io::ErrorKind::TimedOut)));
            assert!(!should_reconnect(&zbus::Error::FDO(Box::new(
                zbus::fdo::Error::ServiceUnknown("x".into())
            ))));
            assert!(!should_reconnect(&zbus::Error::Failure("x".into())));
            assert!(!should_reconnect(&zbus::Error::InvalidReply));
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
            notifier.close(id).expect("closed");
            std::thread::sleep(std::time::Duration::from_millis(500));
            println!("signals: {:?}", seen.lock().unwrap());
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::{Notification, Notify, NotifyError, Signal};

    /// Desktop notifications are only implemented on Linux for now.
    pub struct Notifier;

    impl Notifier {
        pub fn new(_on_signal: impl Fn(Signal) + Send + Sync + 'static) -> Self {
            Self
        }
    }

    impl Notify for Notifier {
        fn send(&self, _n: &Notification<'_>) -> Result<u32, NotifyError> {
            Err(NotifyError("not supported on this system".into()))
        }

        fn close(&self, _id: u32) -> Result<(), NotifyError> {
            Ok(())
        }
    }
}
