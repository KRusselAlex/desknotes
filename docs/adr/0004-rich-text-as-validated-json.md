# ADR-0004: Rich text stored as validated Tiptap JSON

Status: Accepted · 2026-11-01

## Context
Notes need rich formatting that survives restarts. Storing HTML would mean storing
markup that a webview may execute or render unsafely.

## Decision
Store the Tiptap (ProseMirror) document JSON. The core validates every save:
maximum 1 MiB, maximum nesting depth 64, node and mark types from an explicit
allowlist, and link `href` limited to `http:`, `https:` and `mailto:`. Only MIT
Tiptap packages are used. Adding an editor extension requires adding its types to the
allowlist; the shared fixture test fails until both sides agree.

## Consequences
- `javascript:` links and unknown nodes are rejected even if the UI is bypassed.
- The note title shown in the manager is derived in Rust from the document text.
- Export to Markdown/HTML, if wanted later, is a pure conversion from JSON.
