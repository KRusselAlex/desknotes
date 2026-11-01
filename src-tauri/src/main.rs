// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before any thread or GTK starts (see docs/adr/0002).
    desknotes_lib::platform::select_display_backend();
    desknotes_lib::run();
}
