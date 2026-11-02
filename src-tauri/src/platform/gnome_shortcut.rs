//! The "Show / hide all notes" keyboard shortcut on GNOME (DES-27).
//!
//! GNOME 46 offers no global-shortcut portal, and XWayland only sees keys while a
//! DeskNotes window has focus. So DeskNotes adds one GNOME custom keyboard shortcut
//! that runs `desknotes --toggle-notes`, only after the person confirms it in
//! Settings. It touches nothing but its own entry: other custom shortcuts are kept.

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
];

/// A key combination, e.g. Ctrl+Alt+N. Parsed from and written as GTK
/// accelerator text (`<Control><Alt>n`), which is what GNOME stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accel {
    ctrl: bool,
    alt: bool,
    shift: bool,
    superkey: bool,
    /// Lower case: a letter or digit, `f1`–`f12`, or `space`.
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
        let key = rest.to_ascii_lowercase();
        let valid = match key.as_str() {
            k if k.len() == 1 => k.chars().all(|c| c.is_ascii_alphanumeric()),
            "space" => true,
            k => k
                .strip_prefix('f')
                .and_then(|n| n.parse::<u8>().ok())
                .is_some_and(|n| (1..=12).contains(&n)),
        };
        valid.then_some(Accel { key, ..accel })
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

fn schema_installed(id: &str) -> bool {
    gio::SettingsSchemaSource::default().is_some_and(|source| source.lookup(id, true).is_some())
}

/// Whether this desktop has GNOME's custom keyboard shortcuts.
pub fn available() -> bool {
    schema_installed(MEDIA_KEYS) && schema_installed(CUSTOM)
}

fn custom_list(media_keys: &gio::Settings) -> Vec<String> {
    media_keys
        .strv(LIST_KEY)
        .iter()
        .map(|p| p.to_string())
        .collect()
}

/// The shortcut DeskNotes set up, if any (and if the person did not remove it).
pub fn current() -> Option<Accel> {
    if !available() {
        return None;
    }
    if !custom_list(&gio::Settings::new(MEDIA_KEYS))
        .iter()
        .any(|p| p == OUR_PATH)
    {
        return None;
    }
    Accel::parse(&gio::Settings::with_path(CUSTOM, OUR_PATH).string("binding"))
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
            let entry = gio::Settings::with_path(CUSTOM, &path);
            if Accel::parse(&entry.string("binding")).as_ref() == Some(accel) {
                found.push(entry.string("name").to_string());
            }
        }
    }
    found
}

/// The command GNOME runs: this executable (or the AppImage file) with `--toggle-notes`.
pub fn toggle_command() -> Result<String, String> {
    let exe = match std::env::var_os("APPIMAGE") {
        Some(path) => std::path::PathBuf::from(path),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    let quoted = gio::glib::shell_quote(exe);
    Ok(format!(
        "{} {}",
        quoted.to_string_lossy(),
        crate::TOGGLE_NOTES_ARG
    ))
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
        assert_eq!(current(), Some(accel.clone()));
        assert_eq!(
            custom_list(&media_keys),
            vec![other.to_string(), OUR_PATH.to_string()]
        );
        let ours = gio::Settings::with_path(CUSTOM, OUR_PATH);
        assert_eq!(ours.string("command"), "/usr/bin/desknotes --toggle-notes");
        assert_eq!(ours.string("name"), NAME);

        remove().unwrap();
        assert_eq!(current(), None);
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
