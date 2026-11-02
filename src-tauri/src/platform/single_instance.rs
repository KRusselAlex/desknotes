//! Telling from outside the app whether DeskNotes is running, for
//! `desknotes --reset-pin` (design D11), which must only run with DeskNotes closed.
//!
//! On Linux, `tauri-plugin-single-instance` (2.5, without its `semver` feature)
//! owns the session-bus name `<bundle identifier>.SingleInstance` while
//! DeskNotes runs. A running DeskNotes started without a session bus cannot be
//! seen; with no bus the caller is told it cannot check, and refuses.

/// The session-bus name the single-instance plugin owns while DeskNotes runs.
pub fn bus_name(identifier: &str) -> String {
    format!("{identifier}.SingleInstance")
}

/// Holds the single-instance name while a reset runs, so DeskNotes cannot
/// start in the meantime. Released when dropped.
pub struct Claim {
    #[cfg(target_os = "linux")]
    connection: zbus::blocking::Connection,
    #[cfg(target_os = "linux")]
    name: String,
}

impl Drop for Claim {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        {
            let _ = self.connection.release_name(self.name.as_str());
        }
    }
}

/// Whether another DeskNotes owns the name now. `Err` when it cannot be told.
pub fn running(identifier: &str) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use zbus::blocking::Connection;
        use zbus::blocking::fdo::DBusProxy;
        use zbus::names::BusName;

        let name = bus_name(identifier);
        let name = BusName::try_from(name.as_str()).map_err(|e| e.to_string())?;
        let connection = Connection::session().map_err(|e| e.to_string())?;
        let proxy = DBusProxy::new(&connection).map_err(|e| e.to_string())?;
        proxy.name_has_owner(name).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = identifier;
        Err("checking for a running DeskNotes is only possible on Linux".into())
    }
}

/// Take the single-instance name, as a running DeskNotes would. `Ok(None)`
/// when another process owns it (DeskNotes is running); `Err` when it cannot be told.
pub fn claim(identifier: &str) -> Result<Option<Claim>, String> {
    #[cfg(target_os = "linux")]
    {
        use zbus::blocking::Connection;
        use zbus::fdo::RequestNameFlags;

        let name = bus_name(identifier);
        let connection = Connection::session().map_err(|e| e.to_string())?;
        match connection.request_name_with_flags(name.as_str(), RequestNameFlags::DoNotQueue.into())
        {
            Ok(_) => Ok(Some(Claim { connection, name })),
            Err(zbus::Error::NameTaken) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = identifier;
        Err("checking for a running DeskNotes is only possible on Linux".into())
    }
}

#[cfg(test)]
mod tests {
    use super::bus_name;

    /// Run alone on a private bus:
    /// `dbus-run-session -- cargo test -p desknotes --lib single_instance -- --ignored`
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs a private D-Bus session bus (dbus-run-session)"]
    fn a_claim_keeps_others_out_until_dropped() {
        use super::{claim, running};
        let id = "io.github.krusselalex.desknotes.test";
        assert_eq!(running(id), Ok(false));
        let first = claim(id).unwrap().expect("free name");
        assert_eq!(running(id), Ok(true));
        assert!(claim(id).unwrap().is_none(), "already owned");
        drop(first);
        assert_eq!(running(id), Ok(false));
    }

    #[test]
    fn name_is_the_plugins() {
        // tauri-plugin-single-instance 2.5.5, src/platform_impl/linux.rs:
        // `identifier` + ".SingleInstance" (the `semver` feature is off).
        assert_eq!(
            bus_name("io.github.krusselalex.desknotes"),
            "io.github.krusselalex.desknotes.SingleInstance"
        );
    }
}
