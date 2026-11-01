# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting:
the **Security** tab of this repository → **Report a vulnerability**.
You should receive an answer within 7 days.

## Supported versions

Only the latest release receives security fixes while DeskNotes is pre-1.0.

## Security model

- All data is local. DeskNotes makes no network requests.
- Note content is stored as validated JSON, never as HTML. Links are limited to
  `http`, `https` and `mailto` in the native layer.
- The planned privacy lock protects against **someone looking at your unlocked screen**.
  It does **not** encrypt the database: anyone who can read your user files can read
  your notes. Use full-disk encryption to protect data at rest.
- The PIN will be stored only as a salted Argon2id hash, never in plain text or logs.
