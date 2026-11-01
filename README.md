# DeskNotes

Lightweight, private sticky notes for the Linux desktop. Built with Tauri 2, React and
SQLite. Free, open source (MIT), offline, no account, no telemetry.

> **Status: early development (Milestone 1 in progress).** Not ready for daily use yet.
> Ubuntu 24.04 (GNOME) is the first target. Windows and macOS are planned; they are not
> claimed as supported until they are built and tested.

## Planned features

- Notes as independent floating windows that keep their place and size across restarts.
- Rich text: bold, italic, underline, strike, headings, lists, checklists, links.
- Per-note colours and typography, high-contrast option.
- Note manager with search, archive and trash (recoverable deletion).
- Privacy lock with a PIN (Argon2id hash, throttled attempts).
- Reminders with local desktop notifications.
- Backup and restore. All data stays on your computer.

See [docs/design.md](docs/design.md) for the full design and milestone plan, and
[docs/adr/](docs/adr/) for architecture decisions.

## Where your data lives

Everything is stored locally in one SQLite file in the operating system's
application-data directory (on Linux: `~/.local/share/io.github.krusselalex.desknotes/`).
DeskNotes makes no network requests. Before a database upgrade, a copy is saved in
the `backups/` folder next to it.

## Development setup (Ubuntu 24.04)

```bash
sudo apt update
sudo apt install build-essential curl wget file libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  librsvg2-dev libxdo-dev libayatana-appindicator3-dev patchelf
```

Install Rust with [rustup](https://rustup.rs) and Node.js 22 or newer. Run, test and build
commands are added to [CONTRIBUTING.md](CONTRIBUTING.md) as each part lands.

## Wayland note

On GNOME Wayland, applications cannot position their own windows or keep them on top.
DeskNotes therefore runs its windows through XWayland by default. Set
`DESKNOTES_BACKEND=wayland` to opt out; position restore and always-on-top are then
unavailable. Details: [ADR-0002](docs/adr/0002-xwayland-on-linux-wayland.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described
in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
