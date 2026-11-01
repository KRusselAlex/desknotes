//! Quit handshake: every open note window saves, then reports whether it could.
//! The app only exits when all of them saved (or stopped answering).

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Round {
    pending: HashSet<String>,
    unsaved: usize,
}

#[derive(Default)]
pub struct QuitCoordinator {
    round: Mutex<Option<Round>>,
    changed: Condvar,
}

impl QuitCoordinator {
    /// Start a quit round waiting for these window labels.
    pub fn begin(&self, labels: HashSet<String>) {
        if let Ok(mut round) = self.round.lock() {
            *round = Some(Round {
                pending: labels,
                unsaved: 0,
            });
        }
    }

    /// A note window answered. Unknown labels and answers outside a round are ignored.
    pub fn report(&self, label: &str, saved: bool) {
        if let Ok(mut guard) = self.round.lock()
            && let Some(round) = guard.as_mut()
            && round.pending.remove(label)
            && !saved
        {
            round.unsaved += 1;
        }
        self.changed.notify_all();
    }

    /// Wait until every window answered or `timeout` passed, end the round and
    /// return how many windows still hold unsaved text. Windows that never
    /// answer are not counted: an unresponsive webview cannot save anyway.
    pub fn wait(&self, timeout: Duration) -> usize {
        let deadline = Instant::now() + timeout;
        let Ok(mut guard) = self.round.lock() else {
            return 0;
        };
        loop {
            let done = guard.as_ref().is_none_or(|r| r.pending.is_empty());
            let left = deadline.saturating_duration_since(Instant::now());
            if done || left.is_zero() {
                break;
            }
            match self.changed.wait_timeout(guard, left) {
                Ok((g, _)) => guard = g,
                Err(_) => return 0,
            }
        }
        guard.take().map(|r| r.unsaved).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn labels(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn all_saved_means_nothing_unsaved() {
        let q = Arc::new(QuitCoordinator::default());
        q.begin(labels(&["note-a", "note-b"]));
        let q2 = q.clone();
        let t = thread::spawn(move || {
            q2.report("note-a", true);
            q2.report("note-b", true);
        });
        assert_eq!(q.wait(Duration::from_secs(2)), 0);
        t.join().unwrap();
    }

    #[test]
    fn a_failed_save_blocks_quit() {
        let q = QuitCoordinator::default();
        q.begin(labels(&["note-a", "note-b"]));
        q.report("note-a", false);
        q.report("note-b", true);
        assert_eq!(q.wait(Duration::from_secs(2)), 1);
    }

    #[test]
    fn silent_windows_time_out_and_unknown_labels_are_ignored() {
        let q = QuitCoordinator::default();
        q.begin(labels(&["note-a"]));
        q.report("note-zzz", false);
        let started = Instant::now();
        assert_eq!(q.wait(Duration::from_millis(150)), 0);
        assert!(started.elapsed() >= Duration::from_millis(150));
    }

    #[test]
    fn reports_outside_a_round_do_nothing() {
        let q = QuitCoordinator::default();
        q.report("note-a", false);
        assert_eq!(q.wait(Duration::from_millis(10)), 0);
    }
}
