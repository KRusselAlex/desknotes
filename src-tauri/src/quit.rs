//! Save-all handshake: every open note window saves, then reports whether it could.
//! Used before quitting, exporting, restoring, hiding all notes and locking private
//! notes. The app only goes ahead when all of them saved (or stopped answering).

use std::collections::HashSet;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Round {
    pending: HashSet<String>,
    unsaved: Vec<String>,
}

/// Window labels after a round: those that answered "not saved", and those
/// that never answered before the timeout.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RoundOutcome {
    pub unsaved: Vec<String>,
    pub silent: Vec<String>,
}

#[derive(Default)]
pub struct QuitCoordinator {
    round: Mutex<Option<Round>>,
    changed: Condvar,
    /// One round at a time: a lock and a quit started together must not
    /// replace each other's list of windows to wait for.
    serial: Mutex<()>,
}

impl QuitCoordinator {
    /// Run one whole round: wait for any other round to finish, start waiting
    /// for `labels`, call `ask` (which asks the windows to save) and wait.
    pub fn run(
        &self,
        labels: HashSet<String>,
        ask: impl FnOnce(),
        timeout: Duration,
    ) -> RoundOutcome {
        let _one_at_a_time = self.serial.lock().unwrap_or_else(|e| e.into_inner());
        self.begin(labels);
        ask();
        self.wait(timeout)
    }

    /// Start a quit round waiting for these window labels.
    pub fn begin(&self, labels: HashSet<String>) {
        if let Ok(mut round) = self.round.lock() {
            *round = Some(Round {
                pending: labels,
                unsaved: Vec::new(),
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
            round.unsaved.push(label.to_owned());
        }
        self.changed.notify_all();
    }

    /// Wait until every window answered or `timeout` passed, end the round and
    /// return which windows still hold unsaved text and which never answered.
    pub fn wait(&self, timeout: Duration) -> RoundOutcome {
        let deadline = Instant::now() + timeout;
        let Ok(mut guard) = self.round.lock() else {
            return RoundOutcome::default();
        };
        loop {
            let done = guard.as_ref().is_none_or(|r| r.pending.is_empty());
            let left = deadline.saturating_duration_since(Instant::now());
            if done || left.is_zero() {
                break;
            }
            match self.changed.wait_timeout(guard, left) {
                Ok((g, _)) => guard = g,
                Err(_) => return RoundOutcome::default(),
            }
        }
        guard
            .take()
            .map(|r| {
                let mut silent: Vec<String> = r.pending.into_iter().collect();
                silent.sort();
                RoundOutcome {
                    unsaved: r.unsaved,
                    silent,
                }
            })
            .unwrap_or_default()
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
        assert_eq!(q.wait(Duration::from_secs(2)), RoundOutcome::default());
        t.join().unwrap();
    }

    #[test]
    fn a_failed_save_blocks_quit() {
        let q = QuitCoordinator::default();
        q.begin(labels(&["note-a", "note-b"]));
        q.report("note-a", false);
        q.report("note-b", true);
        assert_eq!(q.wait(Duration::from_secs(2)).unsaved, vec!["note-a"]);
    }

    #[test]
    fn silent_windows_time_out_and_unknown_labels_are_ignored() {
        let q = QuitCoordinator::default();
        q.begin(labels(&["note-a"]));
        q.report("note-zzz", false);
        let started = Instant::now();
        assert_eq!(
            q.wait(Duration::from_millis(150)),
            RoundOutcome {
                unsaved: vec![],
                silent: vec!["note-a".to_string()],
            }
        );
        assert!(started.elapsed() >= Duration::from_millis(150));
    }

    #[test]
    fn run_asks_after_the_round_starts() {
        let q = QuitCoordinator::default();
        let outcome = q.run(
            labels(&["note-a", "note-b"]),
            || {
                q.report("note-a", true);
                q.report("note-b", false);
            },
            Duration::from_secs(2),
        );
        assert_eq!(outcome.unsaved, vec!["note-b"]);
        assert!(outcome.silent.is_empty());
    }

    #[test]
    fn reports_outside_a_round_do_nothing() {
        let q = QuitCoordinator::default();
        q.report("note-a", false);
        assert_eq!(q.wait(Duration::from_millis(10)), RoundOutcome::default());
    }
}
