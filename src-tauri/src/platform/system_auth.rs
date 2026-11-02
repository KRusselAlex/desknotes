//! Proving to be the Ubuntu account owner with the system password (polkit),
//! the normal way back from a forgotten PIN (design D5).

/// The polkit action DeskNotes asks for. Defined in
/// `src-tauri/polkit/io.github.krusselalex.desknotes.policy`: the person at
/// the active session must type their own password, every time (`auth_self`).
pub const ACTION_ID: &str = "io.github.krusselalex.desknotes.reset-pin";

/// Installed by the `.deb` package; an AppImage cannot install it (design D6).
pub const POLICY_FILE: &str = "/usr/share/polkit-1/actions/io.github.krusselalex.desknotes.policy";

/// Where Ubuntu installs `pkcheck` (package `polkitd`). Never looked up on
/// the PATH: a `pkcheck` earlier on the PATH could say yes to anything.
pub const PKCHECK: &str = "/usr/bin/pkcheck";

/// Whether the Ubuntu-password route can be offered: the polkit policy is
/// installed, [`PKCHECK`] is an executable file and DeskNotes is not running
/// from an AppImage (which sets `APPDIR`).
pub fn system_auth_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::path::Path;
        Path::new(POLICY_FILE).is_file()
            && is_executable_file(Path::new(PKCHECK))
            && std::env::var_os("APPDIR").is_none()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// A regular file (symlinks followed) that someone may execute.
#[cfg(target_os = "linux")]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The process start time (field 22 of `/proc/<pid>/stat`, in clock ticks
/// since boot). Field 2, the command name, is in parentheses and may contain
/// spaces or parentheses itself, so fields are counted after the last `)`.
#[cfg(any(target_os = "linux", test))]
fn start_time_from_stat(stat: &str) -> Option<u64> {
    let after_name = &stat[stat.rfind(')')? + 1..];
    // Fields 3, 4, … follow the name: field 22 is the 20th of them.
    after_name.split_whitespace().nth(19)?.parse().ok()
}

/// The `--process` subject for `pkcheck`: `pid,start-time`, so polkit can tell
/// this process from a later one given the same id.
#[cfg(any(target_os = "linux", test))]
fn process_subject(pid: u32, stat: &str) -> Option<String> {
    Some(format!("{pid},{}", start_time_from_stat(stat)?))
}

/// Ask for the Ubuntu password with the system's own dialog (polkit agent).
/// True only when polkit says this process is authorised (`pkcheck` exit 0);
/// a wrong password, a cancelled dialog, a missing agent or any error is false.
///
/// Blocks until the dialog closes: never call it on the main thread, and never
/// while holding the database lock. Nothing typed passes through DeskNotes.
pub fn ask_system_password() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};
        let pid = std::process::id();
        let subject = std::fs::read_to_string("/proc/self/stat")
            .ok()
            .and_then(|stat| process_subject(pid, &stat));
        let Some(subject) = subject else {
            eprintln!(
                "DeskNotes: the Ubuntu password could not be asked for: no process start time"
            );
            return false;
        };
        let status = Command::new(PKCHECK)
            .args(["--action-id", ACTION_ID, "--process", &subject])
            .arg("--allow-user-interaction")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) => status.success(),
            Err(e) => {
                eprintln!("DeskNotes: the Ubuntu password could not be asked for: {e}");
                false
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{ACTION_ID, PKCHECK, POLICY_FILE, process_subject, start_time_from_stat};

    const POLICY: &str = include_str!("../../polkit/io.github.krusselalex.desknotes.policy");

    /// Text of every `<tag>…</tag>` in `xml`, in order.
    fn texts<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
        let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
        let mut found = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find(&open) {
            let after = &rest[start + open.len()..];
            let end = after.find(&close).expect("closing tag");
            found.push(after[..end].trim());
            rest = &after[end + close.len()..];
        }
        found
    }

    #[test]
    fn policy_asks_for_the_own_password_every_time() {
        assert_eq!(POLICY.matches("<action ").count(), 1, "one action");
        assert!(
            POLICY.contains(&format!("<action id=\"{ACTION_ID}\">")),
            "action id"
        );
        assert_eq!(texts(POLICY, "allow_active"), ["auth_self"]);
        assert_eq!(texts(POLICY, "allow_inactive"), ["no"]);
        assert_eq!(texts(POLICY, "allow_any"), ["no"]);
        assert_eq!(
            texts(POLICY, "message"),
            ["Authenticate to choose a new DeskNotes PIN"]
        );
    }

    #[test]
    fn deb_installs_the_policy_where_it_is_looked_for() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        let source = conf["bundle"]["linux"]["deb"]["files"][POLICY_FILE].as_str();
        assert_eq!(
            source,
            Some("polkit/io.github.krusselalex.desknotes.policy"),
            "bundle.linux.deb.files must install the policy at {POLICY_FILE}"
        );
    }

    #[test]
    fn pkcheck_is_never_looked_up_on_the_path() {
        assert!(std::path::Path::new(PKCHECK).is_absolute());
    }

    #[test]
    fn the_process_start_time_is_field_22_of_stat() {
        let stat = "65937 (cat) R 65926 65926 65926 0 -1 4194304 123 0 0 0 0 0 0 0 20 0 1 0 452830 \
                    8646656 429 18446744073709551615";
        assert_eq!(start_time_from_stat(stat), Some(452_830));
        assert_eq!(
            process_subject(65937, stat).as_deref(),
            Some("65937,452830")
        );
        // A command name with spaces and parentheses does not shift the fields.
        let odd = "7 (a) b (c) S 1 7 7 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 99 0 0";
        assert_eq!(start_time_from_stat(odd), Some(99));
        assert_eq!(start_time_from_stat("7 (cut short) S 1 2"), None);
        assert_eq!(start_time_from_stat("no name at all"), None);
        assert_eq!(process_subject(7, ""), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_has_a_start_time() {
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        assert!(start_time_from_stat(&stat).is_some(), "{stat}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_executable_files_count_as_pkcheck() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("desknotes-pkcheck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pkcheck");
        std::fs::write(&file, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!super::is_executable_file(&file), "not executable");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(super::is_executable_file(&file));
        assert!(!super::is_executable_file(&dir), "a directory");
        assert!(!super::is_executable_file(&dir.join("missing")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
