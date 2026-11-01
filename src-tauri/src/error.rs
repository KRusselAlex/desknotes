use desknotes_core::CoreError;
use serde::Serialize;

/// Error sent to the webview: a stable code plus a readable message.
/// Never includes note content.
#[derive(Debug, Serialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<CoreError> for IpcError {
    fn from(e: CoreError) -> Self {
        Self::new(e.code(), e.to_string())
    }
}

impl From<tauri::Error> for IpcError {
    fn from(e: tauri::Error) -> Self {
        Self::new("window", e.to_string())
    }
}

pub type IpcResult<T> = Result<T, IpcError>;

/// "N notes have unsaved text", used when an action needs every note saved first.
pub fn unsaved_error(count: usize) -> IpcError {
    IpcError::new(
        "unsaved",
        format!(
            "{count} {} unsaved text. Press Retry in the note showing \"Not saved\" first.",
            if count == 1 { "note has" } else { "notes have" }
        ),
    )
}
