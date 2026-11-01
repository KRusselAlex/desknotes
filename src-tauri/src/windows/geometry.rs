//! Debounced persistence of note window geometry.
//!
//! Window managers send many Moved/Resized events while dragging. One worker
//! thread keeps the latest geometry per note and writes it once the window has
//! been still for `DEBOUNCE`. When there is nothing pending it blocks, so it
//! costs no CPU while idle.

use std::collections::HashMap;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use desknotes_core::Database;

const DEBOUNCE: Duration = Duration::from_millis(400);

#[derive(Clone, Copy)]
struct Geometry {
    position: Option<(f64, f64)>,
    width: f64,
    height: f64,
}

enum Message {
    Update(String, Geometry),
    Flush(Sender<()>),
}

pub struct GeometryWriter {
    tx: Sender<Message>,
}

impl GeometryWriter {
    pub fn spawn(db: Arc<Mutex<Option<Database>>>) -> Self {
        let (tx, rx) = mpsc::channel::<Message>();
        thread::Builder::new()
            .name("desknotes-geometry".into())
            .spawn(move || {
                let mut pending: HashMap<String, (Geometry, Instant)> = HashMap::new();
                loop {
                    let message = if pending.is_empty() {
                        rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
                    } else {
                        rx.recv_timeout(DEBOUNCE)
                    };
                    match message {
                        Ok(Message::Update(id, g)) => {
                            pending.insert(id, (g, Instant::now()));
                        }
                        Ok(Message::Flush(done)) => {
                            write(&db, pending.drain().map(|(id, (g, _))| (id, g)));
                            let _ = done.send(());
                            continue;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            write(&db, pending.drain().map(|(id, (g, _))| (id, g)));
                            break;
                        }
                    }
                    let settled: Vec<String> = pending
                        .iter()
                        .filter(|(_, (_, at))| at.elapsed() >= DEBOUNCE)
                        .map(|(id, _)| id.clone())
                        .collect();
                    let ready = settled
                        .into_iter()
                        .filter_map(|id| pending.remove(&id).map(|(g, _)| (id, g)));
                    write(&db, ready);
                }
            })
            .expect("failed to start geometry thread");
        Self { tx }
    }

    pub fn update(&self, note_id: &str, position: Option<(f64, f64)>, width: f64, height: f64) {
        let g = Geometry {
            position,
            width,
            height,
        };
        let _ = self.tx.send(Message::Update(note_id.to_string(), g));
    }

    /// Write everything pending now and wait (at most 2 s) until it is done.
    pub fn flush(&self) {
        let (done_tx, done_rx) = mpsc::channel();
        if self.tx.send(Message::Flush(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

fn write(db: &Mutex<Option<Database>>, items: impl Iterator<Item = (String, Geometry)>) {
    let Ok(guard) = db.lock() else { return };
    let Some(db) = guard.as_ref() else { return };
    for (id, g) in items {
        // NotFound is expected if the note was purged meanwhile.
        if let Err(e) = db.set_window_geometry(&id, g.position, g.width, g.height)
            && e.code() != "not_found"
        {
            eprintln!("DeskNotes: could not save window position: {e}");
        }
    }
}
