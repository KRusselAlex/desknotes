# ADR-0006: Note windows share one WebKit web process on Linux

Status: Accepted · 2026-11-01

## Context
Each note is its own window (ADR-0001). With WebKitGTK every window started its own
web process, about 80 MiB each: 1 GB for 10 notes and 2.4 GB for 30 (measured,
docs/testing/m1-verification.md). That is too heavy for an app meant to stay open.

## Decision
On Linux, every note window is created as a WebKit "related view" of the manager's
webview (`WebviewWindowBuilder::with_related_view`), so all windows share one web
process. The manager is created first at startup (hidden when notes are shown) and
lives for the whole session. Because the WebKit view object may only be used on the
main thread, note windows are built inside the manager's `with_webview` callback.

## Consequences
- Measured on the same machine and build: 10 notes 1005 → 446 MiB, about 28–30 notes
  2390 → 737 MiB. Each extra note costs about 20 MiB instead of about 80.
- Opening a note is asynchronous on Linux: errors are reported in the manager.
- If the shared web process crashes, every window reloads together.
- Windows and macOS are unaffected (their webviews already share processes differently).
