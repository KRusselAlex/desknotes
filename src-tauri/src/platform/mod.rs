//! Operating-system specifics. Everything Linux-only lives here (ADR-0002).

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
