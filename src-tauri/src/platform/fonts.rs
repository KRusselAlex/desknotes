//! Installed font families, for the "Font" picker in the note settings window.

use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::time::Duration;

use desknotes_core::validation::validate_font_name;

/// The last list read, kept for the rest of the session: fonts rarely change
/// while DeskNotes runs, and listing them can take a moment.
static CACHE: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// How long `fc-list` may take before the picker gives up on it.
#[cfg(target_os = "linux")]
const FC_LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// Font family names installed on this system, sorted, without duplicates.
/// Any failure gives an empty list: the picker still offers "System default".
/// A list read once is reused; an empty one is tried again next time.
pub fn families() -> Vec<String> {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(names) = cache.as_ref() {
        return names.clone();
    }
    let names = read_families();
    if !names.is_empty() {
        *cache = Some(names.clone());
    }
    names
}

#[cfg(target_os = "linux")]
fn read_families() -> Vec<String> {
    // An absolute path: nothing from PATH is ever run.
    let mut command = std::process::Command::new("/usr/bin/fc-list");
    command.args(["--format", "%{family[0]}\\n", ":"]);
    run_with_timeout(command, FC_LIST_TIMEOUT)
        .map(|out| parse_families(&String::from_utf8_lossy(&out)))
        .unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn read_families() -> Vec<String> {
    Vec::new()
}

/// Standard output of `command` if it succeeds within `timeout`; otherwise the
/// process is killed and `None` returned.
#[cfg(target_os = "linux")]
fn run_with_timeout(mut command: std::process::Command, timeout: Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    use std::process::Stdio;

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Read on another thread: a full pipe would otherwise stall the process.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = tx.send(stdout.read_to_end(&mut out).map(|_| out));
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => child.wait().ok()?.success().then_some(out),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// One family per line in, a clean list out: trimmed, names that the note
/// font rule refuses dropped, duplicates (any case) removed, sorted ignoring case.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_families(output: &str) -> Vec<String> {
    let mut names: Vec<String> = output
        .lines()
        .filter_map(|line| validate_font_name(line).ok().flatten())
        .collect();
    names.sort_by_cached_key(|n| n.to_lowercase());
    // Equal ignoring case now sit next to each other: keep the first.
    names.dedup_by_key(|n| n.to_lowercase());
    names
}

#[cfg(test)]
mod tests {
    use super::parse_families;
    #[cfg(target_os = "linux")]
    use super::run_with_timeout;
    #[cfg(target_os = "linux")]
    use std::time::{Duration, Instant};

    #[test]
    fn parse_families_dedupes_sorts_and_drops_unsafe_names() {
        let output = "DejaVu Sans\nUbuntu\ndejavu sans\nBad\"Name\n\n  Noto Sans  \n";
        assert_eq!(
            parse_families(output),
            vec!["DejaVu Sans", "Noto Sans", "Ubuntu"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_command_that_takes_too_long_is_stopped() {
        let mut slow = std::process::Command::new("/bin/sh");
        slow.args(["-c", "echo early; sleep 30"]);
        let started = Instant::now();
        assert_eq!(run_with_timeout(slow, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_quick_command_gives_its_output_and_a_failing_one_none() {
        let mut quick = std::process::Command::new("/bin/sh");
        quick.args(["-c", "echo Ubuntu"]);
        assert_eq!(
            run_with_timeout(quick, Duration::from_secs(5)).as_deref(),
            Some(&b"Ubuntu\n"[..])
        );
        let mut failing = std::process::Command::new("/bin/sh");
        failing.args(["-c", "echo x; exit 1"]);
        assert_eq!(run_with_timeout(failing, Duration::from_secs(5)), None);
    }
}
