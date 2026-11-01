//! Validation of data crossing the IPC boundary (docs/adr/0004).
//!
//! The webview is treated as untrusted input: every document is checked here
//! even though the editor already produces well-formed JSON.

use serde_json::Value;

use crate::error::{CoreError, CoreResult};

pub const MAX_CONTENT_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const TITLE_MAX_CHARS: usize = 80;

/// Node types produced by the editor extensions we ship.
/// Adding an editor extension means adding its node here (see tests/fixtures).
const ALLOWED_NODES: &[&str] = &[
    "doc",
    "paragraph",
    "text",
    "heading",
    "bulletList",
    "orderedList",
    "listItem",
    "taskList",
    "taskItem",
    "blockquote",
    "codeBlock",
    "hardBreak",
    "horizontalRule",
];

/// Must equal the marks the editor schema can load. A mark accepted here but
/// unknown to the editor would make the note open empty (and be overwritten).
const ALLOWED_MARKS: &[&str] = &["bold", "italic", "underline", "strike", "code", "link"];

/// Attributes a link mark may carry. `class` must stay null so pasted HTML
/// cannot give note text the app's own CSS classes.
const LINK_ATTRS: &[&str] = &["href", "target", "rel", "class", "title"];

const ALLOWED_LINK_SCHEMES: &[&str] = &["http:", "https:", "mailto:"];

/// An empty document, used for new notes.
pub fn empty_doc() -> Value {
    serde_json::json!({ "type": "doc", "content": [ { "type": "paragraph" } ] })
}

/// Parse and validate a serialized editor document.
pub fn parse_content(raw: &str) -> CoreResult<Value> {
    if raw.len() > MAX_CONTENT_BYTES {
        return Err(invalid(format!(
            "note is too large ({} bytes, limit {MAX_CONTENT_BYTES})",
            raw.len()
        )));
    }
    let doc: Value =
        serde_json::from_str(raw).map_err(|e| invalid(format!("content is not JSON: {e}")))?;
    validate_doc(&doc)?;
    Ok(doc)
}

pub fn validate_doc(doc: &Value) -> CoreResult<()> {
    if doc.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(invalid("root node must be of type \"doc\""));
    }
    validate_node(doc, 0)
}

fn validate_node(node: &Value, depth: usize) -> CoreResult<()> {
    if depth > MAX_DEPTH {
        return Err(invalid("document is nested too deeply"));
    }
    let obj = node
        .as_object()
        .ok_or_else(|| invalid("node must be an object"))?;
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("node is missing its type"))?;
    if !ALLOWED_NODES.contains(&kind) {
        return Err(invalid(format!("unsupported node type \"{kind}\"")));
    }

    validate_attrs(obj.get("attrs"))?;

    match kind {
        "text" => {
            if !obj.get("text").is_some_and(Value::is_string) {
                return Err(invalid("text node without text"));
            }
        }
        "heading" => {
            let level = obj
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(Value::as_u64);
            if !matches!(level, Some(1..=6)) {
                return Err(invalid("heading level must be 1 to 6"));
            }
        }
        _ => {}
    }

    if let Some(marks) = obj.get("marks") {
        let marks = marks
            .as_array()
            .ok_or_else(|| invalid("marks must be an array"))?;
        for mark in marks {
            validate_mark(mark)?;
        }
    }

    if let Some(children) = obj.get("content") {
        let children = children
            .as_array()
            .ok_or_else(|| invalid("content must be an array"))?;
        for child in children {
            validate_node(child, depth + 1)?;
        }
    }
    Ok(())
}

fn validate_mark(mark: &Value) -> CoreResult<()> {
    let kind = mark
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("mark is missing its type"))?;
    if !ALLOWED_MARKS.contains(&kind) {
        return Err(invalid(format!("unsupported mark \"{kind}\"")));
    }
    let attrs = mark.get("attrs");
    validate_attrs(attrs)?;
    if kind == "link" {
        let attrs = attrs
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("link without attributes"))?;
        if let Some(key) = attrs.keys().find(|k| !LINK_ATTRS.contains(&k.as_str())) {
            return Err(invalid(format!("unsupported link attribute \"{key}\"")));
        }
        let href = attrs
            .get("href")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("link without href"))?;
        if !is_safe_link(href) {
            return Err(invalid("link must use http, https or mailto"));
        }
        if !attrs.get("class").is_none_or(Value::is_null) {
            return Err(invalid("links cannot carry a CSS class"));
        }
        if !attrs
            .get("target")
            .is_none_or(|t| t.is_null() || t.as_str() == Some("_blank"))
        {
            return Err(invalid("link target must be _blank or empty"));
        }
    }
    Ok(())
}

/// Attributes, when present, are a flat object of strings, numbers, booleans or null.
fn validate_attrs(attrs: Option<&Value>) -> CoreResult<()> {
    let Some(attrs) = attrs else { return Ok(()) };
    let obj = attrs
        .as_object()
        .ok_or_else(|| invalid("attributes must be an object"))?;
    if obj.values().any(|v| v.is_array() || v.is_object()) {
        return Err(invalid("attribute values must be plain values"));
    }
    Ok(())
}

/// True for absolute http(s) and mailto links only. Rejects `javascript:`,
/// `data:`, `file:` and scheme-less values.
pub fn is_safe_link(href: &str) -> bool {
    let lower = href.trim().to_ascii_lowercase();
    // Reject control characters that browsers strip before parsing the scheme.
    if lower.chars().any(|c| c.is_control()) {
        return false;
    }
    ALLOWED_LINK_SCHEMES.iter().any(|s| lower.starts_with(s))
}

/// Note IDs are UUIDs. Checking them keeps window labels and SQL inputs tame.
pub fn parse_note_id(id: &str) -> CoreResult<String> {
    uuid::Uuid::parse_str(id)
        .map(|u| u.hyphenated().to_string())
        .map_err(|_| invalid("note id must be a UUID"))
}

/// `#rrggbb` only.
pub fn validate_color(color: &str) -> CoreResult<String> {
    let ok = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(color.to_ascii_lowercase())
    } else {
        Err(invalid("color must look like #rrggbb"))
    }
}

/// Text of each top-level block, in order.
fn block_texts(doc: &Value) -> Vec<String> {
    fn collect(node: &Value, out: &mut String) {
        match node.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = node.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
            }
            Some("hardBreak") => out.push(' '),
            _ => {}
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for (i, child) in children.iter().enumerate() {
                // Separate nested blocks (list items, task items) with a space.
                if i > 0 && child.get("type").and_then(Value::as_str) != Some("text") {
                    out.push(' ');
                }
                collect(child, out);
            }
        }
    }
    doc.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .map(|b| {
                    let mut s = String::new();
                    collect(b, &mut s);
                    s
                })
                .collect()
        })
        .unwrap_or_default()
}

/// First non-empty line of text, trimmed to `TITLE_MAX_CHARS` characters.
pub fn derive_title(doc: &Value) -> String {
    block_texts(doc)
        .into_iter()
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|t| !t.is_empty())
        .map(|t| t.chars().take(TITLE_MAX_CHARS).collect())
        .unwrap_or_default()
}

/// A short excerpt of the document around the first case-insensitive match
/// of `needle` (already lower-cased), or `None` if it does not occur.
pub fn derive_snippet(doc: &Value, needle: &str) -> Option<String> {
    const BEFORE: usize = 24;
    const AFTER: usize = 60;
    if needle.is_empty() {
        return None;
    }
    let text: Vec<char> = block_texts(doc)
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    let needle: Vec<char> = needle.chars().collect();
    let lower = |c: &char| c.to_lowercase().collect::<String>();
    let start = (0..text.len()).find(|&i| {
        i + needle.len() <= text.len()
            && text[i..i + needle.len()]
                .iter()
                .zip(&needle)
                .all(|(a, b)| lower(a) == b.to_string())
    })?;
    let from = start.saturating_sub(BEFORE);
    let to = (start + needle.len() + AFTER).min(text.len());
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    let excerpt: String = text[from..to].iter().collect();
    out.push_str(excerpt.trim());
    if to < text.len() {
        out.push('…');
    }
    Some(out)
}

/// Lower-cased plain text used for search. Derived from the document on every save.
pub fn derive_search_text(doc: &Value) -> String {
    block_texts(doc).join("\n").to_lowercase()
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/rich-doc.json");

    #[test]
    fn shared_fixture_is_valid() {
        let doc = parse_content(FIXTURE).expect("fixture produced by the editor must validate");
        assert_eq!(derive_title(&doc), "Groceries for Saturday");
    }

    #[test]
    fn shared_link_cases_match_the_typescript_rule() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../tests/fixtures/links.json")).unwrap();
        for case in cases {
            let href = case["href"].as_str().unwrap();
            assert_eq!(
                is_safe_link(href),
                case["safe"].as_bool().unwrap(),
                "{href:?}"
            );
        }
    }

    #[test]
    fn rejects_javascript_links() {
        let doc = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"JavaScript:alert(1)"}}]}
        ]}]});
        assert!(validate_doc(&doc).is_err());
        assert!(!is_safe_link(" javascript:alert(1)"));
        assert!(!is_safe_link("java\tscript:alert(1)"));
        assert!(!is_safe_link("data:text/html,hi"));
        assert!(!is_safe_link("file:///etc/passwd"));
        assert!(is_safe_link("https://example.org"));
        assert!(is_safe_link("mailto:a@b.c"));
    }

    #[test]
    fn rejects_unknown_nodes_marks_and_bad_roots() {
        let unknown = json!({"type":"doc","content":[{"type":"iframe"}]});
        assert!(validate_doc(&unknown).is_err());
        let bad_mark = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"x","marks":[{"type":"script"}]}]}]});
        assert!(validate_doc(&bad_mark).is_err());
        assert!(validate_doc(&json!({"type":"paragraph"})).is_err());
        assert!(parse_content("<p>html</p>").is_err());
    }

    #[test]
    fn rejects_oversized_and_too_deep_documents() {
        let big = format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{}"}}]}}]}}"#,
            "a".repeat(MAX_CONTENT_BYTES)
        );
        assert!(parse_content(&big).is_err());

        let mut node = json!({"type":"paragraph"});
        for _ in 0..(MAX_DEPTH + 2) {
            node = json!({"type":"blockquote","content":[node]});
        }
        assert!(validate_doc(&json!({"type":"doc","content":[node]})).is_err());
    }

    #[test]
    fn marks_the_editor_cannot_load_are_rejected() {
        for mark in ["textStyle", "highlight"] {
            let doc = json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"x","marks":[{"type":mark}]}]}]});
            assert!(validate_doc(&doc).is_err(), "{mark} must be rejected");
        }
    }

    #[test]
    fn link_attributes_are_restricted() {
        let link = |attrs: Value| {
            json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"x","marks":[{"type":"link","attrs":attrs}]}]}]})
        };
        assert!(
            validate_doc(&link(
                json!({"href":"https://a.b","class":null,"target":"_blank"})
            ))
            .is_ok()
        );
        assert!(validate_doc(&link(json!({"href":"https://a.b","class":"dn-popover"}))).is_err());
        assert!(validate_doc(&link(json!({"href":"https://a.b","onclick":"x"}))).is_err());
        assert!(validate_doc(&link(json!({"href":"https://a.b","target":"_top"}))).is_err());
        let nested =
            json!({"type":"doc","content":[{"type":"heading","attrs":{"level":2,"x":{"y":1}}}]});
        assert!(validate_doc(&nested).is_err());
    }

    #[test]
    fn heading_level_is_checked() {
        let bad = json!({"type":"doc","content":[{"type":"heading","attrs":{"level":9}}]});
        assert!(validate_doc(&bad).is_err());
    }

    #[test]
    fn title_skips_empty_blocks_and_truncates() {
        let doc = json!({"type":"doc","content":[
            {"type":"paragraph"},
            {"type":"paragraph","content":[{"type":"text","text":"  Hello   world  "}]}
        ]});
        assert_eq!(derive_title(&doc), "Hello world");
        let long = json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"é".repeat(200)}]}]});
        assert_eq!(derive_title(&long).chars().count(), TITLE_MAX_CHARS);
        assert_eq!(derive_title(&empty_doc()), "");
    }

    #[test]
    fn note_ids_must_be_uuids() {
        let id = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        assert_eq!(parse_note_id(id).unwrap(), id);
        assert_eq!(parse_note_id(&id.to_uppercase()).unwrap(), id);
        assert!(parse_note_id("../../etc").is_err());
        assert!(parse_note_id("note-1").is_err());
    }

    #[test]
    fn snippet_shows_text_around_the_first_match() {
        let doc = json!({"type":"doc","content":[
            {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Bike repair"}]},
            {"type":"paragraph","content":[{"type":"text","text":"Booked for Saturday morning at BikeWorks, bring the old chain and the receipt from last year please."}]}
        ]});
        assert_eq!(
            derive_snippet(&doc, "bike").unwrap(),
            "Bike repair Booked for Saturday morning at BikeWorks, bring the…"
        );
        let later = derive_snippet(&doc, "receipt").unwrap();
        assert!(
            later.starts_with('…') && later.contains("receipt"),
            "{later}"
        );
        assert_eq!(derive_snippet(&doc, "absent"), None);
        assert_eq!(derive_snippet(&doc, ""), None);
        let accents = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Réunion ÉCOLE"}]}]});
        assert_eq!(derive_snippet(&accents, "école").unwrap(), "Réunion ÉCOLE");
    }

    #[test]
    fn colors() {
        assert_eq!(validate_color("#ABCDEF").unwrap(), "#abcdef");
        assert!(validate_color("red").is_err());
        assert!(validate_color("#12345g").is_err());
        assert!(validate_color("#1234567").is_err());
    }
}
