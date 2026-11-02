//! Proving to be the Ubuntu account owner with the system password (polkit),
//! the normal way back from a forgotten PIN (design D5).

/// The polkit action DeskNotes asks for. Defined in
/// `src-tauri/polkit/io.github.krusselalex.desknotes.policy`: the person at
/// the active session must type their own password, every time (`auth_self`).
pub const ACTION_ID: &str = "io.github.krusselalex.desknotes.reset-pin";

/// Installed by the `.deb` package; an AppImage cannot install it (design D6).
pub const POLICY_FILE: &str = "/usr/share/polkit-1/actions/io.github.krusselalex.desknotes.policy";

/// Whether the Ubuntu-password route can be offered: the polkit policy is
/// installed, `pkcheck` is on the PATH and DeskNotes is not running from an
/// AppImage (which sets `APPDIR`).
pub fn system_auth_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::env;
        use std::path::Path;
        let on_path = |name: &str| {
            env::var_os("PATH")
                .is_some_and(|path| env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        };
        Path::new(POLICY_FILE).is_file() && on_path("pkcheck") && env::var_os("APPDIR").is_none()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Ask for the Ubuntu password with the system's own dialog (polkit agent).
/// True only when polkit says this process is authorised (`pkcheck` exit 0);
/// a wrong password, a cancelled dialog, a missing agent or any error is false.
///
/// Blocks until the dialog closes: never call it on the main thread, and never
/// while holding the database lock. Nothing typed passes through DeskNotes.
pub fn ask_system_password() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        let status = Command::new("pkcheck")
            .args(["--action-id", ACTION_ID, "--process"])
            .arg(std::process::id().to_string())
            .arg("--allow-user-interaction")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) => status.success(),
            Err(e) => {
                eprintln!("DeskNotes: the Ubuntu password could not be asked for: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{ACTION_ID, POLICY_FILE};

    const POLICY: &str = include_str!("../../polkit/io.github.krusselalex.desknotes.policy");

    /// Text of every `<tag>…</tag>` in `xml`, in order.
    fn texts<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        let mut found = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find(&open) {
            let after = &rest[start + open.len()..];
            let end = after.find(&close).expect("closing tag");
            found.push(after[..end].trim());
            rest = &after[end + close.len()..];
        }
        found
    }

    #[test]
    fn policy_asks_for_the_own_password_every_time() {
        assert_eq!(POLICY.matches("<action ").count(), 1, "one action");
        assert!(
            POLICY.contains(&format!("<action id=\"{ACTION_ID}\">")),
            "action id"
        );
        assert_eq!(texts(POLICY, "allow_active"), ["auth_self"]);
        assert_eq!(texts(POLICY, "allow_inactive"), ["no"]);
        assert_eq!(texts(POLICY, "allow_any"), ["no"]);
        assert_eq!(
            texts(POLICY, "message"),
            ["Authenticate to choose a new DeskNotes PIN"]
        );
    }

    #[test]
    fn deb_installs_the_policy_where_it_is_looked_for() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        let source = conf["bundle"]["linux"]["deb"]["files"][POLICY_FILE].as_str();
        assert_eq!(
            source,
            Some("polkit/io.github.krusselalex.desknotes.policy"),
            "bundle.linux.deb.files must install the policy at {POLICY_FILE}"
        );
    }
}
