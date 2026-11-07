//! Operating-system specifics. Everything Linux-only lives here (ADR-0002).

pub mod clipboard;
pub mod fonts;
#[cfg(target_os = "linux")]
pub mod gnome_shortcut;
pub mod lock_triggers;
pub mod notify;
pub mod single_instance;
pub mod system_auth;

/// On Linux Wayland sessions, run through XWayland unless the user opted out,
/// because native Wayland does not let apps place windows or keep them on top.
pub fn select_display_backend() {
    #[cfg(target_os = "linux")]
    {
        use std::env;
        let wayland_session = env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
            || env::var_os("WAYLAND_DISPLAY").is_some();
        let opted_out = env::var("DESKNOTES_BACKEND").is_ok_and(|v| v == "wayland");
        let xwayland_available = env::var_os("DISPLAY").is_some();
        if wayland_session
            && !opted_out
            && xwayland_available
            && env::var_os("GDK_BACKEND").is_none()
        {
            // SAFETY: called first thing in main(), before any other thread
            // exists, so nothing can read the environment concurrently.
            unsafe { env::set_var("GDK_BACKEND", "x11") };
        }
    }
}

/// The `PRETTY_NAME` line of an os-release file, without quotes. The last
/// assignment wins, as when the file is sourced by a shell. `None` when absent
/// or empty.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_pretty_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .filter_map(|line| line.trim().strip_prefix("PRETTY_NAME="))
        .next_back()
        .map(|v| v.trim().trim_matches(['"', '\'']).trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// The name from the first os-release file that exists (`/etc/os-release`, then
/// `/usr/lib/os-release`, per freedesktop). `candidates` holds each file's
/// contents, or `None` when the file is missing. A file that exists but has no
/// usable name does not fall through to the next one.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn pretty_name_from_candidates<'a>(
    candidates: impl IntoIterator<Item = Option<&'a str>>,
) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .next()
        .and_then(parse_pretty_name)
}

/// A readable name of the operating system, for the About window.
pub fn os_name() -> String {
    #[cfg(target_os = "linux")]
    {
        let etc = std::fs::read_to_string("/etc/os-release").ok();
        let usr = if etc.is_none() {
            std::fs::read_to_string("/usr/lib/os-release").ok()
        } else {
            None
        };
        pretty_name_from_candidates([etc.as_deref(), usr.as_deref()])
            .unwrap_or_else(|| "Linux".to_owned())
    }
    #[cfg(target_os = "windows")]
    {
        "Windows".to_owned()
    }
    #[cfg(target_os = "macos")]
    {
        "macOS".to_owned()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        std::env::consts::OS.to_owned()
    }
}

/// Whether this session lets the app set and read global window positions.
pub fn window_positioning_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::env;
        let wayland_session = env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland")
            || env::var_os("WAYLAND_DISPLAY").is_some();
        let forced_x11 = env::var("GDK_BACKEND").is_ok_and(|v| v.starts_with("x11"));
        !wayland_session || forced_x11
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// The folder holding every app's data for this user, as Tauri finds it
/// (`dirs::data_dir`): `$XDG_DATA_HOME` when absolute, else `~/.local/share`.
/// Used where no Tauri app exists yet (`desknotes --reset-pin`). `None` off
/// Linux and when neither variable gives a folder.
pub fn user_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        use std::env;
        data_dir_from(env::var_os("XDG_DATA_HOME"), env::var_os("HOME"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn data_dir_from(
    xdg_data_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    xdg_data_home
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| {
            home.filter(|h| !h.is_empty())
                .map(|h| PathBuf::from(h).join(".local/share"))
        })
}

#[cfg(test)]
mod tests {
    use super::{data_dir_from, parse_pretty_name, pretty_name_from_candidates};
    use std::path::PathBuf;

    #[test]
    fn pretty_name_is_read_quoted_or_unquoted() {
        let quoted = "NAME=\"Ubuntu\"\nVERSION=\"24.04.1 LTS (Noble Numbat)\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n";
        assert_eq!(
            parse_pretty_name(quoted).as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
        assert_eq!(
            parse_pretty_name("ID=arch\nPRETTY_NAME=Arch Linux\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(
            parse_pretty_name("PRETTY_NAME='Debian GNU/Linux 12'\n").as_deref(),
            Some("Debian GNU/Linux 12")
        );
        assert_eq!(parse_pretty_name("NAME=Ubuntu\nID=ubuntu\n"), None);
        assert_eq!(parse_pretty_name("PRETTY_NAME=\"\"\n"), None);
        assert_eq!(parse_pretty_name(""), None);
        // A longer key that merely starts with the same letters is not it.
        assert_eq!(parse_pretty_name("PRETTY_NAME_X=\"no\"\n"), None);
    }

    #[test]
    fn last_pretty_name_wins_like_a_shell() {
        let twice = "PRETTY_NAME=\"First\"\nID=x\nPRETTY_NAME=\"Second\"\n";
        assert_eq!(parse_pretty_name(twice).as_deref(), Some("Second"));
        // An empty last assignment overrides too, so there is no name.
        assert_eq!(parse_pretty_name("PRETTY_NAME=A\nPRETTY_NAME=\n"), None);
    }

    #[test]
    fn os_release_candidates_are_tried_in_order() {
        let etc = "PRETTY_NAME=\"Etc\"\n";
        let usr = "PRETTY_NAME=\"Usr\"\n";
        assert_eq!(
            pretty_name_from_candidates([Some(etc), Some(usr)]).as_deref(),
            Some("Etc")
        );
        assert_eq!(
            pretty_name_from_candidates([None, Some(usr)]).as_deref(),
            Some("Usr")
        );
        assert_eq!(pretty_name_from_candidates([None, None]), None);
        // An existing file without a name is the file, so the next is not read.
        assert_eq!(
            pretty_name_from_candidates([Some("ID=x\n"), Some(usr)]),
            None
        );
    }

    #[test]
    fn data_dir_follows_xdg_like_tauri() {
        let some = |s: &str| Some(s.into());
        assert_eq!(
            data_dir_from(some("/data"), some("/home/a")),
            Some(PathBuf::from("/data"))
        );
        // A relative XDG_DATA_HOME is ignored, as in `dirs`.
        assert_eq!(
            data_dir_from(some("data"), some("/home/a")),
            Some(PathBuf::from("/home/a/.local/share"))
        );
        assert_eq!(
            data_dir_from(None, some("/home/a")),
            Some(PathBuf::from("/home/a/.local/share"))
        );
        assert_eq!(data_dir_from(None, some("")), None);
        assert_eq!(data_dir_from(None, None), None);
    }
}
