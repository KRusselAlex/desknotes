//! Tauri commands: the only entry points from the webview into native code.
//! Each one validates its inputs and delegates to desknotes-core.

pub mod app;
pub mod backup;
pub mod notes;
pub mod settings;
