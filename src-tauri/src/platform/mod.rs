//! Operating-system specifics. Everything Linux-only lives here (ADR-0002).

#[cfg(target_os = "linux")]
pub mod gnome_shortcut;
pub mod lock_triggers;
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
    use super::data_dir_from;
    use std::path::PathBuf;

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
