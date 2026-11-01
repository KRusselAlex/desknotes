use std::sync::{Arc, Mutex};

use desknotes_core::{CoreResult, Database};
use tauri::{AppHandle, Manager};

use crate::error::{IpcError, IpcResult};
use crate::windows::geometry::GeometryWriter;

pub struct AppState {
    db: Arc<Mutex<Option<Database>>>,
    /// Problems found at startup, shown in the manager. Never contains note text.
    startup_errors: Mutex<Vec<String>>,
    pub geometry: GeometryWriter,
}

impl AppState {
    pub fn open(app: &AppHandle) -> Self {
        let mut errors = Vec::new();
        let db = match app.path().app_data_dir() {
            Ok(dir) => match Database::open(&dir.join("desknotes.db"), &dir.join("backups")) {
                Ok(db) => Some(db),
                Err(e) => {
                    errors.push(format!("The notes database could not be opened: {e}"));
                    None
                }
            },
            Err(e) => {
                errors.push(format!("No application data folder is available: {e}"));
                None
            }
        };
        for e in &errors {
            eprintln!("DeskNotes: {e}");
        }
        let db = Arc::new(Mutex::new(db));
        Self {
            geometry: GeometryWriter::spawn(db.clone()),
            db,
            startup_errors: Mutex::new(errors),
        }
    }

    /// Run `f` with the database, mapping every failure to an IPC error.
    pub fn with_db<T>(&self, f: impl FnOnce(&Database) -> CoreResult<T>) -> IpcResult<T> {
        let guard = self
            .db
            .lock()
            .map_err(|_| IpcError::new("internal", "database lock poisoned"))?;
        let db = guard.as_ref().ok_or_else(|| {
            IpcError::new("database_unavailable", "the notes database is not open")
        })?;
        Ok(f(db)?)
    }

    pub fn push_error(&self, message: String) {
        eprintln!("DeskNotes: {message}");
        if let Ok(mut errors) = self.startup_errors.lock() {
            errors.push(message);
        }
    }

    pub fn errors(&self) -> Vec<String> {
        self.startup_errors
            .lock()
            .map(|e| e.clone())
            .unwrap_or_default()
    }
}
