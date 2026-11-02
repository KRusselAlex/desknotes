//! The "Show / hide all notes" keyboard shortcut on GNOME (DES-27).
//!
//! GNOME 46 offers no global-shortcut portal, and XWayland only sees keys while a
//! DeskNotes window has focus. So DeskNotes adds one GNOME custom keyboard shortcut
//! that runs `desknotes --toggle-notes`, only after the person confirms it in
//! Settings. It touches nothing but its own entry: other custom shortcuts are kept.

use std::path::{Path, PathBuf};

use gio::prelude::*;

const MEDIA_KEYS: &str = "org.gnome.settings-daemon.plugins.media-keys";
const CUSTOM: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const LIST_KEY: &str = "custom-keybindings";
/// DeskNotes' own entry in the list of custom shortcuts.
const OUR_PATH: &str =
    "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/desknotes/";
/// Shown in GNOME Settings → Keyboard → Custom Shortcuts.
const NAME: &str = "DeskNotes: show / hide all notes";
/// Where GNOME's own key bindings live, checked for conflicts.
const BINDING_SCHEMAS: &[&str] = &[
    "org.gnome.desktop.wm.keybindings",
    "org.gnome.shell.keybindings",
    "org.gnome.mutter.keybindings",
    "org.gnome.mutter.wayland.keybindings",
    MEDIA_KEYS,
    // Ubuntu's dock and tiling extensions (skipped when not installed).
    "org.gnome.shell.extensions.dash-to-dock",
    "org.gnome.shell.extensions.tiling-assistant",
];

/// A key combination, e.g. Ctrl+Alt+N. Parsed from and written as GTK
/// accelerator text (`<Control><Alt>n`), which is what GNOME stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accel {
    ctrl: bool,
    alt: bool,
    shift: bool,
    superkey: bool,
    /// GTK's key name: a lower-case letter or a digit, `F1`–`F12`, or `space`.
    /// GTK cannot read `f5`, so the case matters (GNOME Settings must show it).
    key: String,
}

impl Accel {
    /// Parse accelerator text. Unknown modifiers or keys give `None`.
    pub fn parse(text: &str) -> Option<Accel> {
        let mut accel = Accel {
            ctrl: false,
            alt: false,
            shift: false,
            superkey: false,
            key: String::new(),
        };
        let mut rest = text.trim();
        while let Some(after) = rest.strip_prefix('<') {
            let (name, tail) = after.split_once('>')?;
            match name.to_ascii_lowercase().as_str() {
                "control" | "ctrl" | "primary" => accel.ctrl = true,
                "alt" | "mod1" => accel.alt = true,
                "shift" => accel.shift = true,
                "super" | "mod4" => accel.superkey = true,
                _ => return None,
            }
            rest = tail;
        }
        let lower = rest.to_ascii_lowercase();
        let key = match lower.as_str() {
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => lower.clone(),
            "space" => lower.clone(),
            k => {
                let n = k.strip_prefix('f')?.parse::<u8>().ok()?;
                if !(1..=12).contains(&n) {
                    return None;
                }
                format!("F{n}")
            }
        };
        Some(Accel { key, ..accel })
    }

    /// Needs Ctrl, Alt or Super: a plain or Shift-only key would take over typing.
    pub fn is_acceptable(&self) -> bool {
        self.ctrl || self.alt || self.superkey
    }

    /// Text stored in GNOME's settings.
    pub fn to_gsettings(&self) -> String {
        let mut text = String::new();
        for (on, name) in [
            (self.ctrl, "<Control>"),
            (self.alt, "<Alt>"),
            (self.shift, "<Shift>"),
            (self.superkey, "<Super>"),
        ] {
            if on {
                text.push_str(name);
            }
        }
        text + &self.key
    }

    /// Readable form, e.g. "Ctrl+Alt+N".
    pub fn label(&self) -> String {
        let mut parts: Vec<String> = [
            (self.ctrl, "Ctrl"),
            (self.alt, "Alt"),
            (self.shift, "Shift"),
            (self.superkey, "Super"),
        ]
        .into_iter()
        .filter(|(on, _)| *on)
        .map(|(_, name)| name.to_string())
        .collect();
        parts.push(match self.key.as_str() {
            "space" => "Space".to_string(),
            k => k.to_ascii_uppercase(),
        });
        parts.join("+")
    }
}

/// The list of custom shortcut paths with ours added once; others keep their order.
fn with_ours(list: &[String]) -> Vec<String> {
    let mut list = list.to_vec();
    if !list.iter().any(|p| p == OUR_PATH) {
        list.push(OUR_PATH.to_string());
    }
    list
}

/// The list without ours; others untouched.
fn without_ours(list: &[String]) -> Vec<String> {
    list.iter().filter(|p| *p != OUR_PATH).cloned().collect()
}

/// The check GLib applies to a settings path; it returns NULL (and gio-rs then
/// crashes) for anything else, and the list may hold entries other tools wrote.
fn is_valid_path(path: &str) -> bool {
    path.starts_with('/') && path.ends_with('/') && !path.contains("//")
}

fn schema_installed(id: &str) -> bool {
    gio::SettingsSchemaSource::default().is_some_and(|source| source.lookup(id, true).is_some())
}

/// Whether this desktop has GNOME's custom keyboard shortcuts. A memory or null
/// settings backend (e.g. an AppImage without dconf) would accept changes and
/// lose them, so it counts as unavailable.
pub fn available() -> bool {
    let backend = gio::SettingsBackend::default().type_().name();
    schema_installed(MEDIA_KEYS)
        && schema_installed(CUSTOM)
        && !matches!(backend, "GMemorySettingsBackend" | "GNullSettingsBackend")
}

fn custom_list(media_keys: &gio::Settings) -> Vec<String> {
    media_keys
        .strv(LIST_KEY)
        .iter()
        .map(|p| p.to_string())
        .collect()
}

/// DeskNotes' shortcut as GNOME has it. `accel` is `None` when the person changed
/// it in GNOME Settings to a key DeskNotes does not handle; it can still be removed.
pub struct Current {
    pub binding: String,
    pub accel: Option<Accel>,
}

/// The shortcut DeskNotes set up, if any (and if the person did not remove it).
pub fn current() -> Option<Current> {
    if !available() {
        return None;
    }
    if !custom_list(&gio::Settings::new(MEDIA_KEYS))
        .iter()
        .any(|p| p == OUR_PATH)
    {
        return None;
    }
    let binding = gio::Settings::with_path(CUSTOM, OUR_PATH)
        .string("binding")
        .to_string();
    let accel = Accel::parse(&binding);
    Some(Current { binding, accel })
}

/// Names of GNOME shortcuts (or other custom shortcuts) already using `accel`.
pub fn conflicts(accel: &Accel) -> Vec<String> {
    let mut found = Vec::new();
    let Some(source) = gio::SettingsSchemaSource::default() else {
        return found;
    };
    for id in BINDING_SCHEMAS {
        let Some(schema) = source.lookup(id, true) else {
            continue;
        };
        let settings = gio::Settings::new(id);
        for key in schema.list_keys() {
            let value = settings.value(&key);
            let bindings: Vec<String> = match value.type_().as_str() {
                "as" => value.get::<Vec<String>>().unwrap_or_default(),
                "s" => value.get::<String>().into_iter().collect(),
                _ => continue,
            };
            if bindings
                .iter()
                .any(|b| Accel::parse(b).as_ref() == Some(accel))
            {
                found.push(key.to_string());
            }
        }
    }
    if available() {
        for path in without_ours(&custom_list(&gio::Settings::new(MEDIA_KEYS))) {
            if !is_valid_path(&path) {
                continue;
            }
            let entry = gio::Settings::with_path(CUSTOM, &path);
            if Accel::parse(&entry.string("binding")).as_ref() == Some(accel) {
                found.push(entry.string("name").to_string());
            }
        }
    }
    found
}

/// The program GNOME should start: this executable, or the AppImage file when
/// DeskNotes really runs from one. `APPIMAGE` alone is not trusted: it is inherited,
/// so DeskNotes started from a terminal inside another AppImage would see that one's.
fn program() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Linux names a replaced executable "… (deleted)", e.g. after a package upgrade.
    let exe = match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(s) => PathBuf::from(s),
        None => exe,
    };
    if let (Some(image), Some(dir)) = (std::env::var_os("APPIMAGE"), std::env::var_os("APPDIR")) {
        let image = PathBuf::from(image);
        if image.is_absolute() && image.is_file() && exe.starts_with(dir) {
            return Ok(image);
        }
    }
    Ok(exe)
}

/// The command line for `program`. GNOME runs custom shortcuts through
/// `g_app_info_create_from_commandline`, which reads `%x` as a field code, so a
/// `%` in the path must be doubled after shell quoting.
fn command_for(program: &Path) -> Result<String, String> {
    let path = program
        .to_str()
        .ok_or("The DeskNotes program path cannot be used in a shortcut.")?;
    let quoted = gio::glib::shell_quote(path);
    let quoted = quoted
        .to_str()
        .ok_or("The DeskNotes program path cannot be used in a shortcut.")?;
    Ok(format!(
        "{} {}",
        quoted.replace('%', "%%"),
        crate::TOGGLE_NOTES_ARG
    ))
}

/// The command GNOME runs: DeskNotes with `--toggle-notes`.
pub fn toggle_command() -> Result<String, String> {
    command_for(&program()?)
}

/// Add or update DeskNotes' custom shortcut. Call only after the person agreed.
pub fn install(accel: &Accel, command: &str) -> Result<(), String> {
    let entry = gio::Settings::with_path(CUSTOM, OUR_PATH);
    let set = |key: &str, value: &str| entry.set_string(key, value).map_err(|e| e.to_string());
    set("name", NAME)?;
    set("command", command)?;
    set("binding", &accel.to_gsettings())?;
    let media_keys = gio::Settings::new(MEDIA_KEYS);
    let list = with_ours(&custom_list(&media_keys));
    let list: Vec<&str> = list.iter().map(String::as_str).collect();
    media_keys
        .set_strv(LIST_KEY, list.as_slice())
        .map_err(|e| e.to_string())?;
    gio::Settings::sync();
    Ok(())
}

/// Remove DeskNotes' custom shortcut; other custom shortcuts are kept.
pub fn remove() -> Result<(), String> {
    let media_keys = gio::Settings::new(MEDIA_KEYS);
    let list = without_ours(&custom_list(&media_keys));
    let list: Vec<&str> = list.iter().map(String::as_str).collect();
    media_keys
        .set_strv(LIST_KEY, list.as_slice())
        .map_err(|e| e.to_string())?;
    let entry = gio::Settings::with_path(CUSTOM, OUR_PATH);
    for key in ["name", "command", "binding"] {
        entry.reset(key);
    }
    gio::Settings::sync();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_writes_gnome_accelerators() {
        let a = Accel::parse("<Control><Alt>n").unwrap();
        assert_eq!(a.to_gsettings(), "<Control><Alt>n");
        assert_eq!(a.label(), "Ctrl+Alt+N");
        // GNOME also writes <Primary> and upper-case keys; they mean the same.
        assert_eq!(Accel::parse("<Primary><Alt>N"), Some(a));
        assert_eq!(Accel::parse("<Super>F5").unwrap().label(), "Super+F5");
        assert_eq!(
            Accel::parse("<Shift><Super>space").unwrap().to_gsettings(),
            "<Shift><Super>space"
        );
    }

    #[test]
    fn writes_f_keys_the_way_gtk_reads_them() {
        // GTK (and so GNOME Settings) cannot read "f5".
        assert_eq!(
            Accel::parse("<Super>f5").unwrap().to_gsettings(),
            "<Super>F5"
        );
        assert_eq!(
            Accel::parse("<Super>F12").unwrap().to_gsettings(),
            "<Super>F12"
        );
        assert_eq!(Accel::parse("<Super>f5"), Accel::parse("<Super>F5"));
        assert_eq!(Accel::parse("<Alt>N").unwrap().to_gsettings(), "<Alt>n");
    }

    #[test]
    fn skips_settings_paths_glib_would_refuse() {
        assert!(is_valid_path(OUR_PATH));
        assert!(!is_valid_path(
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0"
        ));
        assert!(!is_valid_path("org/gnome/x/"));
        assert!(!is_valid_path("/org//gnome/x/"));
    }

    #[test]
    fn quotes_the_program_and_doubles_percent_signs() {
        assert_eq!(
            command_for(Path::new("/usr/bin/desknotes")).unwrap(),
            "'/usr/bin/desknotes' --toggle-notes"
        );
        assert_eq!(
            command_for(Path::new("/home/me/My Apps/Desk%20Notes.AppImage")).unwrap(),
            "'/home/me/My Apps/Desk%%20Notes.AppImage' --toggle-notes"
        );
        assert_eq!(
            command_for(Path::new("/home/me/it's/desknotes")).unwrap(),
            "'/home/me/it'\\''s/desknotes' --toggle-notes"
        );
    }

    #[test]
    fn refuses_unknown_text() {
        for bad in [
            "",
            "<Control>",
            "<Hyper>n",
            "<Control>Print",
            "<Control>f13",
            "<Control>nn",
            "<Control><Alt",
            "<Alt>é",
        ] {
            assert_eq!(Accel::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn needs_ctrl_alt_or_super() {
        assert!(!Accel::parse("n").unwrap().is_acceptable());
        assert!(!Accel::parse("<Shift>n").unwrap().is_acceptable());
        assert!(Accel::parse("<Alt>n").unwrap().is_acceptable());
        assert!(Accel::parse("<Super>n").unwrap().is_acceptable());
    }

    /// Uses real GIO settings, so it only runs against a scratch file, never the
    /// person's desktop settings:
    /// `GSETTINGS_BACKEND=keyfile XDG_CONFIG_HOME=/tmp/x cargo test -p desknotes -- --ignored gnome`
    #[test]
    #[ignore = "needs GNOME schemas and a scratch keyfile backend"]
    fn installs_and_removes_against_scratch_settings() {
        let config = std::env::var("XDG_CONFIG_HOME").unwrap_or_default();
        assert_eq!(
            std::env::var("GSETTINGS_BACKEND").as_deref(),
            Ok("keyfile"),
            "refusing: not a scratch backend"
        );
        assert!(
            config.starts_with("/tmp/"),
            "refusing: XDG_CONFIG_HOME must be a scratch folder"
        );
        assert!(available(), "GNOME schemas not installed");

        let other = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
        let media_keys = gio::Settings::new(MEDIA_KEYS);
        media_keys.set_strv(LIST_KEY, [other].as_slice()).unwrap();
        let other_entry = gio::Settings::with_path(CUSTOM, other);
        other_entry.set_string("name", "Someone else's").unwrap();
        other_entry.set_string("binding", "<Super>e").unwrap();

        let accel = Accel::parse("<Control><Alt>n").unwrap();
        assert!(conflicts(&accel).is_empty());
        assert_eq!(
            conflicts(&Accel::parse("<Super>e").unwrap()),
            vec!["Someone else's"]
        );
        // GNOME's own default: Ctrl+Alt+T opens the terminal.
        assert_eq!(
            conflicts(&Accel::parse("<Control><Alt>t").unwrap()),
            vec!["terminal"]
        );
        install(&accel, "/usr/bin/desknotes --toggle-notes").unwrap();
        assert_eq!(current().and_then(|c| c.accel), Some(accel.clone()));
        assert_eq!(
            custom_list(&media_keys),
            vec![other.to_string(), OUR_PATH.to_string()]
        );
        let ours = gio::Settings::with_path(CUSTOM, OUR_PATH);
        assert_eq!(ours.string("command"), "/usr/bin/desknotes --toggle-notes");
        assert_eq!(ours.string("name"), NAME);

        remove().unwrap();
        assert!(current().is_none());
        assert_eq!(custom_list(&media_keys), vec![other.to_string()]);
        assert_eq!(
            other_entry.string("binding"),
            "<Super>e",
            "other shortcut untouched"
        );
    }

    #[test]
    fn adds_and_removes_only_its_own_entry() {
        let others = vec![
            "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/".to_string(),
        ];
        let added = with_ours(&others);
        assert_eq!(added, vec![others[0].clone(), OUR_PATH.to_string()]);
        assert_eq!(with_ours(&added), added, "added once");
        assert_eq!(without_ours(&added), others);
        assert_eq!(without_ours(&others), others);
    }
}
