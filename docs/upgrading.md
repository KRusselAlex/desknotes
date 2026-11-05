# Upgrading and rolling back DeskNotes

Your notes live in one folder on your computer:

```
~/.local/share/io.github.krusselalex.desknotes/
```

The database is the file `desknotes.db` in that folder. DeskNotes never checks for
updates and never contacts a server: you download a new version yourself from the
[releases page](https://github.com/KRusselAlex/desknotes/releases) and install it.
Older releases stay on that page.

## The copy made before every upgrade

When a new version has to change the layout of the database, it first saves a copy:

```
~/.local/share/io.github.krusselalex.desknotes/backups/pre-migration-v3-1793520000000.db
```

- `v3` is the layout number of the database the copy was made from. The long number is
  the time it was made (milliseconds since 1970); a larger number is a newer copy.
- It is one complete file with all your notes, written before anything was changed.
- DeskNotes never deletes these files. If an upgrade changes nothing in the database
  (for example when you install the same version again), no copy is made.
- Other files in `backups/` called `pre-restore-….db` come from Settings → Backup →
  Restore. They are not used for rolling back.

You can also export your notes from Settings → Backup at any time.

## Installing a new version

Quit DeskNotes first (see [step 1 of rolling back](#1-quit-desknotes)), then install.

### The .deb package (Ubuntu, Debian)

Open a terminal in the folder with the file and run:

```bash
sudo apt install ./DeskNotes_<version>_amd64.deb
```

Replace `<version>` with the number in the file name, for example `0.2.0`. To install
the same version again (to repair it), add `--reinstall`:

```bash
sudo apt install --reinstall ./DeskNotes_<version>_amd64.deb
```

If apt prints a notice that the file cannot be accessed by the `_apt` user ("unsandboxed"),
it is harmless. Copying the file to `/tmp` first avoids it:

```bash
cp DeskNotes_<version>_amd64.deb /tmp/ && sudo apt install /tmp/DeskNotes_<version>_amd64.deb
```

Start DeskNotes from the applications menu. To see which version is installed:

```bash
dpkg-query -W desk-notes
```

### The AppImage (other Linux distributions)

```bash
chmod +x DeskNotes_<version>_amd64.AppImage
./DeskNotes_<version>_amd64.AppImage
```

It uses the same data folder as the `.deb`. A new version is a new file; delete the old
file yourself when you no longer need it. On Ubuntu 22.04 and later AppImages need
`sudo apt install libfuse2t64` once.

### Checking a download (optional)

Every release has a `SHA256SUMS` file. Put it in the same folder as your download and run:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

`gh attestation verify DeskNotes_<version>_amd64.deb --repo KRusselAlex/desknotes` (needs
the GitHub CLI) checks that GitHub's build system made the file from this repository.

### Beta versions

A release marked **Pre-release** on the releases page, such as `0.3.0-beta.1`, is a beta for
testing. It uses the same data folder and makes the same copy before upgrading.

When you install the final release over a beta (for example `0.3.0` over `0.3.0-beta.1`),
apt says the package will be **DOWNGRADED**. That is expected: for `.deb` files, the final
number counts as older than its beta. Nothing happens to your notes. Type `Y` to continue.
Going back to an older release shows the same notice.

## If DeskNotes says "Your notes were saved by a newer version"

You installed an older DeskNotes, but your notes were last opened by a newer one. DeskNotes
shows:

> Your notes were saved by a newer version of DeskNotes. Install that version (or newer) to
> open them; nothing was changed.

This is safe. DeskNotes refused to open the database and did not change a byte of it. Either
install the newer version again, or roll back as described next.

## Rolling back to an older version

Use this if a new version does not work for you and you want the old one back. Read this
first: **notes you wrote or changed after the upgrade are not in the copy.** They are not
lost. The steps below move your current database into a folder called `rolled-back-…` and
never delete it, and you can [put it back](#getting-the-newer-notes-back) later.

Do not use Settings → Backup to go back. A file exported by a new version cannot be
imported by an old one.

**Which copy?** The `v` number in the copy's name is the layout number of the version you
are going back to. It is the last migration number on the `Database:` line of that version in
[CHANGELOG.md](../CHANGELOG.md):

| Going back to | CHANGELOG says | Use the copy named |
|---|---|---|
| 0.2.0 | migration 3 | `pre-migration-v3-….db` |
| 0.1.0 | migrations 1–2 | `pre-migration-v2-….db` |

The steps below use `v3` (going back to 0.2.0). Change the `3` if you go back to another
version.

### 1. Quit DeskNotes

Closing the windows is not enough: DeskNotes keeps running in the tray. Use the tray menu
**Quit DeskNotes** (or the same item in the manager's menu). Then check:

```bash
pgrep -x desknotes
```

If it prints a number, DeskNotes is still running. If it prints nothing, go on.

### 2. See which copy will be used

```bash
ls ~/.local/share/io.github.krusselalex.desknotes/backups/pre-migration-v3-*.db
```

The last line, with the largest number, is the newest. If the command says "No such
file", there is no copy for that version: stop here and do not continue.

### 3. Set the current database aside and put the copy in its place

Paste the whole block. It stops at the first problem. It picks the newest `v3` copy, makes a
folder named `rolled-back-` plus the date and time, **moves** (does not delete)
`desknotes.db` and its `desknotes.db-wal` and `desknotes.db-shm` files into it, and then
**copies** the backup to `desknotes.db`. The `-wal` and `-shm` files must not stay behind,
because SQLite would apply them to the restored file.

```bash
cd ~/.local/share/io.github.krusselalex.desknotes &&
copy="$(ls backups/pre-migration-v3-*.db | sort | tail -n1)" &&
[ -f "$copy" ] &&
dest="rolled-back-$(date +%Y-%m-%d-%H%M%S)" &&
mkdir "$dest" &&
mv desknotes.db* "$dest"/ &&
cp "$copy" desknotes.db &&
echo "Restored $copy. Your newer notes are in $dest/"
```

### 4. Install the older version

Download it from the [releases page](https://github.com/KRusselAlex/desknotes/releases)
and install it as described above, for example:

```bash
sudo apt install ./DeskNotes_0.2.0_amd64.deb
```

apt says the package will be **DOWNGRADED**. That is expected and changes no data; type `Y`.
For the AppImage, just run the older file.

### 5. Start DeskNotes

Start it from the applications menu (or run the AppImage). It opens the restored notes.

### Getting the newer notes back

The database you moved aside is still there. To use it again, quit DeskNotes (step 1), then
run this block. It sets the current database aside the same way and copies the old files
back. Before you paste it, replace `rolled-back-<date>` with the folder name from step 3
(`ls -d ~/.local/share/io.github.krusselalex.desknotes/rolled-back-*` lists them) and keep
the quotes. If the folder name is wrong, nothing is moved.

```bash
cd ~/.local/share/io.github.krusselalex.desknotes &&
old="rolled-back-<date>" &&
[ -f "$old/desknotes.db" ] &&
dest="rolled-back-$(date +%Y-%m-%d-%H%M%S)" &&
mkdir "$dest" &&
mv desknotes.db* "$dest"/ &&
cp "$old"/desknotes.db* .
```

Then install the newer version again and start it. DeskNotes will make a new
`pre-migration-…` copy if it has to upgrade the database again.
