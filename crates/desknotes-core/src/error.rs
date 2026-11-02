use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid data: {0}")]
    Validation(String),
    #[error("note not found: {0}")]
    NotFound(String),
    #[error("operation not allowed: {0}")]
    NotAllowed(String),
    /// A locked private note was asked to change, be copied or be destroyed,
    /// or a whole-collection action needs the PIN first (design D12, §4.4).
    #[error("private notes are locked")]
    PrivateLocked,
    #[error(
        "database schema version {found} is newer than this DeskNotes supports ({supported}); \
         it was left untouched"
    )]
    SchemaTooNew { found: i64, supported: i64 },
}

impl CoreError {
    /// Stable machine-readable code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Database(_) => "database",
            CoreError::Io(_) => "io",
            CoreError::Validation(_) => "validation",
            CoreError::NotFound(_) => "not_found",
            CoreError::NotAllowed(_) => "not_allowed",
            CoreError::PrivateLocked => "private_locked",
            CoreError::SchemaTooNew { .. } => "schema_too_new",
        }
    }
}

pub type CoreResult<T> = Result<T, CoreError>;
