//! Proving to be the Ubuntu account owner with the system password (polkit),
//! the normal way back from a forgotten PIN (design D5). Task 7 adds the prompt.

/// Installed by the `.deb` package; an AppImage cannot install it (design D6).
#[cfg(target_os = "linux")]
const POLICY_FILE: &str = "/usr/share/polkit-1/actions/io.github.krusselalex.desknotes.policy";

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
