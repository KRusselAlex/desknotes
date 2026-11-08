//! Validation of data crossing the IPC boundary (docs/adr/0004).
//!
//! The webview is treated as untrusted input: every document is checked here
//! even though the editor already produces well-formed JSON.

use std::ops::RangeInclusive;

use serde_json::Value;

use crate::error::{CoreError, CoreResult};
use crate::model::{Appearance, PRIVATE_LABEL_MAX_CHARS};

pub const MAX_CONTENT_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const TITLE_MAX_CHARS: usize = 80;

/// Text size in px.
pub const FONT_SIZES: RangeInclusive<u8> = 10..=32;
/// The text colours the settings window offers (lower-case).
pub const TEXT_COLORS: [&str; 4] = ["#201e1d", "#8c491a", "#56633f", "#1d4f91"];
/// Line height in percent, in steps of 5.
pub const LINE_SPACINGS: RangeInclusive<u16> = 100..=200;
/// Window opacity in percent, in steps of 5.
pub const OPACITIES: RangeInclusive<u8> = 80..=100;
/// Longest font family name, in characters.
pub const FONT_NAME_MAX_CHARS: usize = 100;

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
    "image",
];

/// Where an `image` node may sit: block containers only, never inside a paragraph
/// or heading (the editor schema is block-level, design: images in notes §5).
const IMAGE_PARENTS: &[&str] = &["doc", "listItem", "taskItem", "blockquote"];

/// Width of an image, in percent of the note's width.
const IMAGE_WIDTHS: RangeInclusive<i64> = 10..=100;

/// Must equal the marks the editor schema can load. A mark accepted here but
/// unknown to the editor would make the note open empty (and be overwritten).
const ALLOWED_MARKS: &[&str] = &[
    "bold",
    "italic",
    "underline",
    "strike",
    "code",
    "link",
    "textStyle",
    "highlight",
];

/// The six text colours of the Aa popover (design N14), lower case.
pub const TEXT_STYLE_COLORS: [&str; 6] = [
    "#201e1d", "#8c491a", "#56633f", "#1d4f91", "#7a1b14", "#5b3a8c",
];

/// The four highlight colours of the Aa popover (design N14), lower case.
pub const HIGHLIGHT_COLORS: [&str; 4] = ["#ffe36e", "#ffc6a5", "#ccdbb2", "#bcd9ff"];

/// Font weights the Aa popover can set on a selection.
pub const FONT_WEIGHTS: [&str; 4] = ["300", "400", "500", "600"];

/// Font size range of a selection, in px (the Note settings range).
const TEXT_STYLE_SIZES: std::ops::RangeInclusive<u32> = 10..=32;

/// Attributes a `textStyle` mark may carry, each optional or null.
const TEXT_STYLE_ATTRS: &[&str] = &["fontFamily", "fontSize", "fontWeight", "color"];

/// Values of the `textAlign` attribute on paragraphs and headings.
const TEXT_ALIGNS: &[&str] = &["left", "center", "right"];

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
    validate_node(doc, 0, "")
}

fn validate_node(node: &Value, depth: usize, parent: &str) -> CoreResult<()> {
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
    validate_text_align(kind, obj.get("attrs"))?;

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
        "image" => validate_image(obj, parent)?,
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
            validate_node(child, depth + 1, kind)?;
        }
    }
    Ok(())
}

/// An `image` node is `{"id": <64 lowercase hex>, "width": <integer 10 to 100 | null>}`
/// and nothing else: no URL, no children, no marks. `width` may be missing (= null).
fn validate_image(node: &serde_json::Map<String, Value>, parent: &str) -> CoreResult<()> {
    if !IMAGE_PARENTS.contains(&parent) {
        return Err(invalid("an image cannot be placed here"));
    }
    if node.contains_key("content") || node.contains_key("marks") {
        return Err(invalid("an image has no content or marks"));
    }
    let attrs = node
        .get("attrs")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("an image needs an id"))?;
    if attrs.keys().any(|k| k != "id" && k != "width") {
        return Err(invalid("an image has only an id and a width"));
    }
    if !attrs
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(is_image_id)
    {
        return Err(invalid("image id must be 64 lowercase hex characters"));
    }
    match attrs.get("width") {
        None | Some(Value::Null) => {}
        Some(w) if w.as_i64().is_some_and(|w| IMAGE_WIDTHS.contains(&w)) => {}
        Some(_) => return Err(invalid("image width must be a whole number from 10 to 100")),
    }
    Ok(())
}

/// 64 lowercase hex characters: the SHA-256 of a stored image.
pub fn is_image_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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
    match kind {
        "textStyle" => validate_text_style(attrs)?,
        "highlight" => validate_highlight(attrs)?,
        _ => {}
    }
    Ok(())
}

/// `textAlign` is allowed on paragraphs and headings only: `left`, `center`,
/// `right` or null. Nothing here rewrites the document.
fn validate_text_align(kind: &str, attrs: Option<&Value>) -> CoreResult<()> {
    let Some(align) = attrs.and_then(|a| a.get("textAlign")) else {
        return Ok(());
    };
    if !matches!(kind, "paragraph" | "heading") {
        return Err(invalid(format!("\"{kind}\" cannot be aligned")));
    }
    match align {
        Value::Null => Ok(()),
        Value::String(a) if TEXT_ALIGNS.contains(&a.as_str()) => Ok(()),
        _ => Err(invalid("text alignment must be left, center or right")),
    }
}

/// A `textStyle` mark carries only `fontFamily`, `fontSize`, `fontWeight` and
/// `color`, each optional or null, and each limited to what the Aa popover sets.
fn validate_text_style(attrs: Option<&Value>) -> CoreResult<()> {
    // Attributes are optional, so a missing object is as good as an empty one.
    let Some(attrs) = attrs.and_then(Value::as_object) else {
        return Ok(());
    };
    for (key, value) in attrs {
        if !TEXT_STYLE_ATTRS.contains(&key.as_str()) {
            return Err(invalid(format!(
                "unsupported textStyle attribute \"{key}\""
            )));
        }
        if value.is_null() {
            continue;
        }
        let text = value
            .as_str()
            .ok_or_else(|| invalid(format!("textStyle {key} must be text")))?;
        match key.as_str() {
            "fontFamily" => {
                validate_font_name(text)?;
            }
            "fontSize" => {
                // Compare with the canonical spelling so "015px" and "+15px" are refused.
                if !TEXT_STYLE_SIZES.clone().any(|n| text == format!("{n}px")) {
                    return Err(invalid("font size must be 10px to 32px in whole pixels"));
                }
            }
            "fontWeight" => {
                if !FONT_WEIGHTS.contains(&text) {
                    return Err(invalid("font weight must be 300, 400, 500 or 600"));
                }
            }
            _ => {
                if !TEXT_STYLE_COLORS.contains(&text.to_ascii_lowercase().as_str()) {
                    return Err(invalid("text colour is not one of the allowed colours"));
                }
            }
        }
    }
    Ok(())
}

/// A `highlight` mark has exactly one attribute, `color`, set to one of the
/// four highlight colours.
fn validate_highlight(attrs: Option<&Value>) -> CoreResult<()> {
    let attrs = attrs
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("highlight without attributes"))?;
    if let Some(key) = attrs.keys().find(|k| k.as_str() != "color") {
        return Err(invalid(format!(
            "unsupported highlight attribute \"{key}\""
        )));
    }
    let color = attrs
        .get("color")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("highlight without a colour"))?;
    if !HIGHLIGHT_COLORS.contains(&color.to_ascii_lowercase().as_str()) {
        return Err(invalid(
            "highlight colour is not one of the allowed colours",
        ));
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

/// Characters that are invisible or reorder the text around them: bidi
/// embeddings, overrides and isolates, zero-width space, word joiner, BOM and
/// soft hyphen. Zero-width joiners (Persian, Indic scripts, emoji) and the
/// direction marks are kept: they change how text joins, not what it says.
fn hides_or_reorders(c: char) -> bool {
    matches!(
        c,
        '\u{202A}'..='\u{202E}'
            | '\u{2066}'..='\u{2069}'
            | '\u{200B}'
            | '\u{2060}'
            | '\u{FEFF}'
            | '\u{00AD}'
    )
}

/// A private note's neutral label, which stands in for the note's text while
/// locked: characters that hide or reorder text are removed (not refused: some
/// keyboards type them, and labels saved before this rule must still save),
/// then trimmed, at most `PRIVATE_LABEL_MAX_CHARS` characters and no control
/// characters. Empty is allowed (the fallback label is used for display).
pub fn validate_private_label(label: &str) -> CoreResult<String> {
    let kept: String = label.chars().filter(|&c| !hides_or_reorders(c)).collect();
    let label = kept.trim();
    if label.chars().count() > PRIVATE_LABEL_MAX_CHARS {
        return Err(invalid(format!(
            "label must be at most {PRIVATE_LABEL_MAX_CHARS} characters"
        )));
    }
    if label.chars().any(char::is_control) {
        return Err(invalid("label must not contain control characters"));
    }
    Ok(label.to_string())
}

/// A font family name for a note: trimmed, at most `FONT_NAME_MAX_CHARS`
/// characters, and free of anything that could break out of a CSS string
/// (control characters, `"`, `\`, `;`). Empty means "system default" (`None`).
pub fn validate_font_name(name: &str) -> CoreResult<Option<String>> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().count() > FONT_NAME_MAX_CHARS {
        return Err(invalid(format!(
            "font name must be at most {FONT_NAME_MAX_CHARS} characters"
        )));
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '\\' | ';'))
    {
        return Err(invalid(
            "font name contains characters that are not allowed",
        ));
    }
    Ok(Some(name.to_string()))
}

/// Check every set field of an appearance and normalise it: the font is
/// trimmed (blank becomes the default) and the text colour lower-cased.
pub fn validate_appearance(mut a: Appearance) -> CoreResult<Appearance> {
    if let Some(font) = a.font.take() {
        a.font = validate_font_name(&font)?;
    }
    if a.font_size.is_some_and(|v| !FONT_SIZES.contains(&v)) {
        return Err(invalid(format!(
            "font size must be {} to {}",
            FONT_SIZES.start(),
            FONT_SIZES.end()
        )));
    }
    if let Some(color) = a.text_color.take() {
        let color = color.to_ascii_lowercase();
        if !TEXT_COLORS.contains(&color.as_str()) {
            return Err(invalid("text colour is not one of the offered colours"));
        }
        a.text_color = Some(color);
    }
    if a.line_spacing
        .is_some_and(|v| !LINE_SPACINGS.contains(&v) || v % 5 != 0)
    {
        return Err(invalid(format!(
            "line spacing must be {} to {} in steps of 5",
            LINE_SPACINGS.start(),
            LINE_SPACINGS.end()
        )));
    }
    if a.opacity
        .is_some_and(|v| !OPACITIES.contains(&v) || v % 5 != 0)
    {
        return Err(invalid(format!(
            "opacity must be {} to {} in steps of 5",
            OPACITIES.start(),
            OPACITIES.end()
        )));
    }
    Ok(a)
}

/// Parse and validate a stored or received appearance (JSON object, known keys only).
pub fn parse_appearance(raw: &str) -> CoreResult<Appearance> {
    let a: Appearance =
        serde_json::from_str(raw).map_err(|e| invalid(format!("appearance is not valid: {e}")))?;
    validate_appearance(a)
}

fn is_image(node: &Value) -> bool {
    node.get("type").and_then(Value::as_str) == Some("image")
}

/// Text of each top-level block, in order. Images are skipped: they add no text,
/// not even a separator, so title, search text and snippets ignore them.
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
            for (i, child) in children.iter().filter(|c| !is_image(c)).enumerate() {
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
                .filter(|b| !is_image(b))
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

/// The distinct image ids of a document, in document order. Meant for a document
/// that passed [`validate_doc`], which bounds its depth.
pub fn image_ids(doc: &Value) -> Vec<String> {
    fn walk(node: &Value, out: &mut Vec<String>) {
        if node.get("type").and_then(Value::as_str) == Some("image")
            && let Some(id) = node.pointer("/attrs/id").and_then(Value::as_str)
            && !out.iter().any(|seen| seen == id)
        {
            out.push(id.to_string());
        }
        if let Some(children) = node.get("content").and_then(Value::as_array) {
            for child in children {
                walk(child, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(doc, &mut out);
    out
}

/// A copy of `doc` with every `taskItem` unticked (`attrs.checked = false`), however
/// deeply nested, or `None` when no item was ticked (so there is nothing to save).
/// Everything else in the document is copied unchanged.
pub fn untick_all(doc: &Value) -> Option<Value> {
    fn walk(node: &mut Value) -> bool {
        let mut changed = false;
        if node.get("type").and_then(Value::as_str) == Some("taskItem")
            && let Some(attrs) = node.get_mut("attrs").and_then(Value::as_object_mut)
            && attrs.get("checked").and_then(Value::as_bool) == Some(true)
        {
            attrs.insert("checked".into(), Value::Bool(false));
            changed = true;
        }
        if let Some(children) = node.get_mut("content").and_then(Value::as_array_mut) {
            for child in children {
                changed |= walk(child);
            }
        }
        changed
    }
    let mut copy = doc.clone();
    walk(&mut copy).then_some(copy)
}

fn invalid(msg: impl Into<String>) -> CoreError {
    CoreError::Validation(msg.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::model::TextDirection;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/rich-doc.json");

    #[test]
    fn shared_fixture_is_valid() {
        let doc = parse_content(FIXTURE).expect("fixture produced by the editor must validate");
        assert_eq!(derive_title(&doc), "Groceries for Saturday");
    }

    fn image_node(attrs: Value) -> Value {
        json!({"type":"image","attrs":attrs})
    }

    fn doc_of(blocks: Vec<Value>) -> Value {
        json!({"type":"doc","content":blocks})
    }

    fn good_id() -> String {
        "a".repeat(64)
    }

    #[test]
    fn image_node_rules() {
        let ok = |attrs: Value| validate_doc(&doc_of(vec![image_node(attrs)])).is_ok();
        assert!(ok(json!({"id": good_id(), "width": 50})));
        assert!(ok(json!({"id": good_id(), "width": null})));
        assert!(ok(json!({"id": good_id(), "width": 10})));
        assert!(ok(json!({"id": good_id(), "width": 100})));
        assert!(
            ok(json!({"id": "0123456789abcdef".repeat(4)})),
            "width is optional"
        );

        // The id must be 64 lowercase hex characters.
        assert!(!ok(json!({"width": 50})));
        assert!(!ok(json!({"id": null})));
        assert!(!ok(json!({"id": 7})));
        assert!(!ok(json!({"id": "a".repeat(63)})));
        assert!(!ok(json!({"id": "a".repeat(65)})));
        assert!(!ok(json!({"id": "A".repeat(64)})));
        assert!(!ok(json!({"id": "g".repeat(64)})));
        assert!(!ok(json!({"id": format!("../{}", "a".repeat(61))})));

        // Width: an integer from 10 to 100, or null.
        assert!(!ok(json!({"id": good_id(), "width": 9})));
        assert!(!ok(json!({"id": good_id(), "width": 101})));
        assert!(!ok(json!({"id": good_id(), "width": -50})));
        assert!(!ok(json!({"id": good_id(), "width": 50.5})));
        assert!(!ok(json!({"id": good_id(), "width": "50"})));

        // Any other attribute is refused.
        assert!(!ok(json!({"id": good_id(), "width": 50, "src": "x"})));
        assert!(!ok(json!({"id": good_id(), "textAlign": "center"})));
        assert!(!ok(json!({"id": good_id(), "alt": null})));

        // No attrs at all means no id.
        assert!(validate_doc(&doc_of(vec![json!({"type":"image"})])).is_err());
        // An image has no children and no marks.
        let with_child =
            json!({"type":"image","attrs":{"id":good_id()},"content":[{"type":"paragraph"}]});
        assert!(validate_doc(&doc_of(vec![with_child])).is_err());
    }

    #[test]
    fn image_is_allowed_only_in_block_containers() {
        let img = || image_node(json!({"id": good_id(), "width": null}));
        let para = || json!({"type":"paragraph"});
        let in_list_item = json!({"type":"bulletList","content":[
            {"type":"listItem","content":[para(), img()]}]});
        let in_ordered = json!({"type":"orderedList","content":[
            {"type":"listItem","content":[img()]}]});
        let in_task = json!({"type":"taskList","content":[
            {"type":"taskItem","attrs":{"checked":false},"content":[para(), img()]}]});
        let in_quote = json!({"type":"blockquote","content":[img()]});
        for good in [in_list_item, in_ordered, in_task, in_quote, img()] {
            assert!(validate_doc(&doc_of(vec![good.clone()])).is_ok(), "{good}");
        }

        let in_paragraph = json!({"type":"paragraph","content":[img()]});
        let in_heading = json!({"type":"heading","attrs":{"level":1},"content":[img()]});
        let in_code = json!({"type":"codeBlock","content":[img()]});
        let in_bullet_list = json!({"type":"bulletList","content":[img()]});
        let in_task_list = json!({"type":"taskList","content":[img()]});
        for bad in [
            in_paragraph,
            in_heading,
            in_code,
            in_bullet_list,
            in_task_list,
        ] {
            assert!(validate_doc(&doc_of(vec![bad.clone()])).is_err(), "{bad}");
        }
    }

    #[test]
    fn images_add_no_text() {
        let text = json!({"type":"paragraph","content":[{"type":"text","text":"Hello World"}]});
        let img = image_node(json!({"id": good_id(), "width": 50}));
        let plain = doc_of(vec![text.clone()]);
        let with_image = doc_of(vec![text.clone(), img.clone()]);
        assert_eq!(derive_title(&plain), derive_title(&with_image));
        assert_eq!(derive_search_text(&plain), derive_search_text(&with_image));
        assert_eq!(
            derive_snippet(&plain, "world"),
            derive_snippet(&with_image, "world")
        );
        // Nested too: no separator is added next to an image.
        let nested = doc_of(vec![
            json!({"type":"blockquote","content":[text.clone(), img.clone()]}),
        ]);
        let nested_plain = doc_of(vec![json!({"type":"blockquote","content":[text.clone()]})]);
        assert_eq!(
            derive_search_text(&nested),
            derive_search_text(&nested_plain)
        );
        // A note with only an image gets the usual empty-note title.
        let only = doc_of(vec![img]);
        assert_eq!(derive_title(&only), "");
        assert_eq!(derive_search_text(&only), "");
    }

    #[test]
    fn image_ids_are_distinct_and_in_document_order() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let img = |id: &str| image_node(json!({"id": id, "width": null}));
        let doc = doc_of(vec![
            img(&b),
            json!({"type":"blockquote","content":[img(&a), img(&b)]}),
            json!({"type":"bulletList","content":[{"type":"listItem","content":[img(&a)]}]}),
        ]);
        assert_eq!(image_ids(&doc), vec![b, a]);
        assert!(image_ids(&empty_doc()).is_empty());
    }

    #[test]
    fn shared_fixture_has_an_image() {
        let doc = parse_content(FIXTURE).unwrap();
        assert_eq!(image_ids(&doc), vec![good_id()]);
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
        for mark in ["subscript", "superscript"] {
            let doc = json!({"type":"doc","content":[{"type":"paragraph","content":[
                {"type":"text","text":"x","marks":[{"type":mark}]}]}]});
            assert!(validate_doc(&doc).is_err(), "{mark} must be rejected");
        }
    }

    fn doc_with_marks(marks: Value) -> Value {
        json!({"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"x","marks":marks}]}]})
    }

    fn text_style(attrs: Value) -> Value {
        doc_with_marks(json!([{"type":"textStyle","attrs":attrs}]))
    }

    fn highlight(attrs: Value) -> Value {
        doc_with_marks(json!([{"type":"highlight","attrs":attrs}]))
    }

    fn doc_with_align(kind: &str, align: Value) -> Value {
        let mut attrs = json!({ "textAlign": align });
        if kind == "heading" {
            attrs["level"] = json!(2);
        }
        json!({"type":"doc","content":[{"type":kind,"attrs":attrs}]})
    }

    #[test]
    fn text_style_accepts_the_spec_values() {
        for color in [
            "#201e1d", "#8c491a", "#56633f", "#1d4f91", "#7a1b14", "#5b3a8c",
        ] {
            assert!(validate_doc(&text_style(json!({ "color": color }))).is_ok());
        }
        for size in ["10px", "15px", "32px"] {
            assert!(validate_doc(&text_style(json!({ "fontSize": size }))).is_ok());
        }
        for weight in ["300", "400", "500", "600"] {
            assert!(validate_doc(&text_style(json!({ "fontWeight": weight }))).is_ok());
        }
        assert!(validate_doc(&text_style(json!({ "fontFamily": "Amiri" }))).is_ok());
        assert!(
            validate_doc(&text_style(json!({
                "fontFamily": null, "fontSize": null, "fontWeight": null, "color": null
            })))
            .is_ok()
        );
        // Colours compare case-insensitively, like validate_color.
        assert!(validate_doc(&text_style(json!({ "color": "#1D4F91" }))).is_ok());
    }

    #[test]
    fn text_style_refuses_other_values() {
        let long_name = "a".repeat(FONT_NAME_MAX_CHARS + 1);
        let bad = [
            json!({ "color": "#000000" }),
            json!({ "color": "red" }),
            json!({ "color": "#201E1D; x" }),
            json!({ "fontSize": "9px" }),
            json!({ "fontSize": "33px" }),
            json!({ "fontSize": "15.5px" }),
            json!({ "fontSize": "15" }),
            json!({ "fontSize": "15pt" }),
            json!({ "fontSize": 15 }),
            json!({ "fontWeight": "700" }),
            json!({ "fontWeight": "bold" }),
            json!({ "fontWeight": 400 }),
            json!({ "fontFamily": "a;b" }),
            json!({ "fontFamily": "a\"b" }),
            json!({ "fontFamily": long_name }),
            json!({ "lineHeight": "2" }),
        ];
        for attrs in bad {
            assert!(
                validate_doc(&text_style(attrs.clone())).is_err(),
                "{attrs} must be refused"
            );
        }
    }

    #[test]
    fn highlight_accepts_only_the_four_colours() {
        for color in ["#ffe36e", "#ffc6a5", "#ccdbb2", "#bcd9ff", "#FFE36E"] {
            assert!(validate_doc(&highlight(json!({ "color": color }))).is_ok());
        }
        assert!(validate_doc(&highlight(json!({ "color": "#ffff00" }))).is_err());
        assert!(validate_doc(&doc_with_marks(json!([{"type":"highlight"}]))).is_err());
        assert!(validate_doc(&highlight(json!({ "color": null }))).is_err());
        assert!(validate_doc(&highlight(json!({ "color": "#ffe36e", "x": "y" }))).is_err());
    }

    #[test]
    fn text_align_values() {
        for kind in ["paragraph", "heading"] {
            for align in [json!("left"), json!("center"), json!("right"), Value::Null] {
                assert!(
                    validate_doc(&doc_with_align(kind, align.clone())).is_ok(),
                    "{kind} {align}"
                );
            }
            for align in [json!("justify"), json!("start")] {
                assert!(
                    validate_doc(&doc_with_align(kind, align.clone())).is_err(),
                    "{kind} {align}"
                );
            }
        }
        // Not allowed on other nodes.
        assert!(validate_doc(&doc_with_align("blockquote", json!("left"))).is_err());
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
    fn private_label_is_trimmed_and_limited() {
        assert_eq!(validate_private_label("  Bank ").unwrap(), "Bank");
        assert_eq!(validate_private_label("   ").unwrap(), "");
        assert_eq!(
            validate_private_label(&"é".repeat(40))
                .unwrap()
                .chars()
                .count(),
            40
        );
        assert_eq!(
            validate_private_label(&"x".repeat(41)).unwrap_err().code(),
            "validation"
        );
        assert_eq!(
            validate_private_label("a\u{7}").unwrap_err().code(),
            "validation"
        );
        assert!(validate_private_label("a\nb").is_err());
    }

    #[test]
    fn private_label_loses_hidden_and_reordering_characters() {
        // A label shown in place of a note's text must read as it is stored (DES-30).
        // Removed, not refused: some keyboards type them (Khmer types U+200B on the
        // space bar), and labels saved before the rule must still save.
        for (label, kept) in [
            ("Bank\u{202E}cod.exe", "Bankcod.exe"),
            ("\u{200B}Bank", "Bank"),
            ("Ba\u{2066}nk\u{2069}", "Bank"),
            ("\u{FEFF}Bank", "Bank"),
            ("Ba\u{2060}nk", "Bank"),
            ("Ba\u{00AD}nk", "Bank"),
            ("Ba\u{202A}nk", "Bank"),
            (" \u{FEFF} ", ""),
        ] {
            assert_eq!(validate_private_label(label).unwrap(), kept, "{label:?}");
        }
        // Joiners that scripts and emoji need, and the direction marks, are kept.
        for label in ["می\u{200C}خواهم", "👩\u{200D}💻 work", "بنك", "A\u{200F}B"] {
            assert_eq!(validate_private_label(label).unwrap(), label);
        }
        // The other checks still refuse.
        assert!(validate_private_label("a\u{200B}\nb").is_err());
        assert!(validate_private_label(&format!("{}\u{200B}", "x".repeat(41))).is_err());
        assert_eq!(
            validate_private_label(&format!("{}\u{200B}", "x".repeat(40))).unwrap(),
            "x".repeat(40),
            "removed characters do not count towards the limit"
        );
    }

    #[test]
    fn colors() {
        assert_eq!(validate_color("#ABCDEF").unwrap(), "#abcdef");
        assert!(validate_color("red").is_err());
        assert!(validate_color("#12345g").is_err());
        assert!(validate_color("#1234567").is_err());
    }

    fn appearance(json: &str) -> CoreResult<Appearance> {
        parse_appearance(json)
    }

    #[test]
    fn appearance_defaults_are_empty() {
        assert_eq!(serde_json::to_string(&Appearance::default()).unwrap(), "{}");
    }

    #[test]
    fn appearance_accepts_the_spec_values() {
        let a = appearance(
            r##"{"font":"  Ubuntu Mono ","fontSize":10,"textColor":"#8C491A",
                "lineSpacing":145,"direction":"rtl","opacity":80}"##,
        )
        .unwrap();
        assert_eq!(a.font.as_deref(), Some("Ubuntu Mono"));
        assert_eq!(a.font_size, Some(10));
        assert_eq!(a.text_color.as_deref(), Some("#8c491a"));
        assert_eq!(a.line_spacing, Some(145));
        assert_eq!(a.direction, Some(TextDirection::Rtl));
        assert_eq!(a.opacity, Some(80));

        assert_eq!(
            appearance(r#"{"fontSize":32}"#).unwrap().font_size,
            Some(32)
        );
        assert_eq!(
            appearance(r#"{"lineSpacing":100}"#).unwrap().line_spacing,
            Some(100)
        );
        assert_eq!(
            appearance(r#"{"lineSpacing":200}"#).unwrap().line_spacing,
            Some(200)
        );
        assert_eq!(appearance(r#"{"opacity":100}"#).unwrap().opacity, Some(100));
        assert_eq!(appearance("{}").unwrap(), Appearance::default());
    }

    #[test]
    fn appearance_refuses_out_of_range() {
        for bad in [
            r#"{"fontSize":9}"#,
            r#"{"fontSize":33}"#,
            r#"{"lineSpacing":95}"#,
            r#"{"lineSpacing":205}"#,
            r#"{"lineSpacing":147}"#,
            r#"{"opacity":75}"#,
            r#"{"opacity":101}"#,
            r#"{"opacity":83}"#,
            r##"{"textColor":"#ffffff"}"##,
            r#"{"direction":"sideways"}"#,
        ] {
            assert_eq!(appearance(bad).unwrap_err().code(), "validation", "{bad}");
        }
    }

    #[test]
    fn appearance_refuses_unsafe_font_names() {
        for bad in ["a\"b", "a;b", "a\\b", "a\u{7}b"] {
            let a = Appearance {
                font: Some(bad.to_string()),
                ..Default::default()
            };
            assert!(validate_appearance(a).is_err(), "{bad:?}");
        }
        let long = Appearance {
            font: Some("x".repeat(FONT_NAME_MAX_CHARS + 1)),
            ..Default::default()
        };
        assert!(validate_appearance(long).is_err());
        let longest = Appearance {
            font: Some("x".repeat(FONT_NAME_MAX_CHARS)),
            ..Default::default()
        };
        assert!(validate_appearance(longest).is_ok());
        for blank in ["", "   "] {
            let a = Appearance {
                font: Some(blank.to_string()),
                ..Default::default()
            };
            assert_eq!(validate_appearance(a).unwrap().font, None);
        }
    }

    #[test]
    fn font_names_are_trimmed_and_checked() {
        assert_eq!(
            validate_font_name(" Noto Sans ").unwrap().as_deref(),
            Some("Noto Sans")
        );
        assert_eq!(validate_font_name("  ").unwrap(), None);
        assert!(validate_font_name("a\"b").is_err());
    }

    #[test]
    fn appearance_refuses_unknown_keys() {
        assert!(appearance(r#"{"fontSize":15,"glow":1}"#).is_err());
        assert!(appearance("not json").is_err());
    }
}
