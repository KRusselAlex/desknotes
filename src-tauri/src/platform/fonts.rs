//! Installed font families, for the "Font" picker in the note settings window.

use desknotes_core::validation::validate_font_name;

/// Font family names installed on this system, sorted, without duplicates.
/// Any failure gives an empty list: the picker still offers "System default".
pub fn families() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        // An absolute path: nothing from PATH is ever run.
        match std::process::Command::new("/usr/bin/fc-list")
            .args(["--format", "%{family[0]}\\n", ":"])
            .output()
        {
            Ok(out) if out.status.success() => {
                parse_families(&String::from_utf8_lossy(&out.stdout))
            }
            _ => Vec::new(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Vec::new()
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

    #[test]
    fn parse_families_dedupes_sorts_and_drops_unsafe_names() {
        let output = "DejaVu Sans\nUbuntu\ndejavu sans\nBad\"Name\n\n  Noto Sans  \n";
        assert_eq!(
            parse_families(output),
            vec!["DejaVu Sans", "Noto Sans", "Ubuntu"]
        );
    }
}
