<p align="center"><img src="assets/logo/desknotes-icon.svg" width="96" height="96" alt=""></p>

# DeskNotes

[![CI](https://github.com/KRusselAlex/desknotes/actions/workflows/ci.yml/badge.svg)](https://github.com/KRusselAlex/desknotes/actions/workflows/ci.yml)

Lightweight, private sticky notes for the Linux desktop. Built with Tauri 2, React and
SQLite. Free, open source (MIT), offline, no account, no telemetry.

> **Status: version 0.3.0-beta.1, a beta of Milestones 3 and 4** (note customization,
> private notes with a PIN, images, reminders, done notes and automation rules). The last
> stable release is 0.2.0, Milestone 2 (desktop reliability), verified on Ubuntu 24.04
> GNOME: notes, manager, tray icon, show / hide all shortcut, backup and restore, and a
> `.deb` package; see [CHANGELOG.md](CHANGELOG.md). Ubuntu is the first target. Windows
> and macOS are planned; they are not claimed as supported until they are built and tested.

## Planned features

- Notes as independent floating windows that keep their place and size across restarts.
- Rich text: bold, italic, underline, strike, headings, lists, checklists, links.
- Per-note colours and typography, high-contrast option.
- Note manager with search, archive and trash (recoverable deletion).
- Privacy lock with a PIN (Argon2id hash, throttled attempts).
- Reminders with local desktop notifications.
- Backup and restore. All data stays on your computer.

How DeskNotes is built today, and what every feature does, is in
[docs/architecture.md](docs/architecture.md). The original Milestone 0 design and
milestone plan are in [docs/design.md](docs/design.md), and the architecture decisions
are in [docs/adr/](docs/adr/).

## Where your data lives

Everything is stored locally in one SQLite file in the operating system's
application-data directory (on Linux: `~/.local/share/io.github.krusselalex.desknotes/`).
DeskNotes makes no network requests. Before a database upgrade, a copy is saved in
the `backups/` folder next to it. How to upgrade, and how to go back to an older version,
is in [docs/upgrading.md](docs/upgrading.md).

## Installing (for users)

Download `DeskNotes_<version>_amd64.deb` from the
[releases page](https://github.com/KRusselAlex/desknotes/releases) and run:

```bash
sudo apt install ./DeskNotes_<version>_amd64.deb
```

- DeskNotes itself is about **10 MB** installed. It uses WebKitGTK and GTK, which a
  normal Ubuntu desktop already has; on a minimal system `apt` installs them for you.
- Start it from the applications menu. Remove it with `sudo apt remove desk-notes`;
  your notes stay in `~/.local/share/io.github.krusselalex.desknotes/`.
- **Other Linux distributions:** download `DeskNotes_<version>_amd64.AppImage` (about
  80 MB, it carries its own WebKitGTK), make it executable and run it. AppImages need the
  FUSE 2 library first: `sudo apt install libfuse2` on Ubuntu 22.04, `libfuse2t64` on
  Ubuntu 24.04 and later.
- To upgrade, install the newer file the same way. To go back to an older version, see
  [docs/upgrading.md](docs/upgrading.md).
- Windows and macOS packages will follow once those platforms are built and tested.

Users never need Rust, Node.js or the `-dev` packages below: those are only for
building DeskNotes from source.

## Development setup (Ubuntu 24.04)

The quickest way is `scripts/setup-ubuntu.sh` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
It installs these packages, which are needed only to **build** DeskNotes:

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
