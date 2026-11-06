//! Image storage and which notes use which image (design: images in notes §4–§6).
//! Images live in the database as blobs, keyed by the SHA-256 of their bytes.

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use serde_json::Value;

use super::Database;
use crate::error::{CoreError, CoreResult};
use crate::image_prep::prepare_image;
use crate::now_ms;
use crate::validation::{image_ids, is_image_id};

/// What the editor needs to place an image: its id and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    pub width: u32,
    pub height: u32,
}

impl Database {
    /// Check, shrink and store an image picked for the note `note_id`, and return
    /// what the editor needs to place it. The same image added twice is stored once.
    ///
    /// Refused like typing is: for a note the lock withholds, a missing note, or a
    /// note locked for editing. This does not touch `note_images`: the reference
    /// appears when the note is saved with the image in it.
    pub fn add_image(&self, note_id: &str, input: &[u8]) -> CoreResult<ImageInfo> {
        self.refuse_if_note_locked(note_id)?;
        let edit_locked: bool = self
            .conn
            .query_row(
                "SELECT edit_locked FROM notes WHERE id = ?1",
                [note_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| CoreError::NotFound(note_id.to_string()))?;
        if edit_locked {
            return Err(CoreError::NotAllowed(
                "this note is locked for editing".into(),
            ));
        }
        let image = prepare_image(input)?;
        self.conn.execute(
            "INSERT OR IGNORE INTO images (id, mime, width, height, bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                image.id,
                image.mime,
                image.width,
                image.height,
                image.bytes,
                now_ms()
            ],
        )?;
        Ok(ImageInfo {
            id: image.id,
            width: image.width,
            height: image.height,
        })
    }

    /// The MIME type and bytes of a stored image, for the shell to serve. `None` for
    /// a malformed or unknown id, and, while the privacy lock is in effect, for an
    /// image that is used by notes none of which is readable (only locked private
    /// notes). An image no note uses is served: a freshly pasted image is not used
    /// until the note saves, and undo can bring back a removed one; nothing private
    /// uses it, so nothing is exposed. Checked here so no caller can get around the lock.
    pub fn image_for_display(&self, id: &str) -> CoreResult<Option<(String, Vec<u8>)>> {
        if !is_image_id(id) {
            return Ok(None);
        }
        let Some(found) = self
            .conn
            .query_row("SELECT mime, bytes FROM images WHERE id = ?1", [id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .optional()?
        else {
            return Ok(None);
        };
        if self.lock_active()? && self.used_only_by_withheld_notes(id)? {
            return Ok(None);
        }
        Ok(Some(found))
    }

    /// Whether notes use this image and none of them is readable right now.
    fn used_only_by_withheld_notes(&self, image_id: &str) -> CoreResult<bool> {
        let mut stmt = self
            .conn
            .prepare("SELECT note_id FROM note_images WHERE image_id = ?1")?;
        let note_ids = stmt
            .query_map([image_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if note_ids.is_empty() {
            return Ok(false);
        }
        Ok(!note_ids
            .iter()
            .any(|note_id| self.refuse_if_note_locked(note_id).is_ok()))
    }

    /// Delete images no note uses (trashed and archived notes still use theirs) and
    /// return how many. The shell calls this once at start-up, never during a session.
    pub fn remove_unused_images(&self) -> CoreResult<usize> {
        Ok(self.conn.execute(
            "DELETE FROM images WHERE id NOT IN (SELECT image_id FROM note_images)",
            [],
        )?)
    }
}

/// Rewrite which images a note uses from its content, inside the transaction that
/// stores that content. Only ids that exist in `images` are recorded: a save is
/// never refused over an image that is missing (design §5).
pub(super) fn sync_note_images_in(
    tx: &Transaction<'_>,
    note_id: &str,
    doc: &Value,
) -> CoreResult<()> {
    tx.execute("DELETE FROM note_images WHERE note_id = ?1", [note_id])?;
    for image_id in image_ids(doc) {
        tx.execute(
            "INSERT INTO note_images (note_id, image_id)
             SELECT ?1, id FROM images WHERE id = ?2",
            params![note_id, image_id],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder, RgbaImage};
    use rusqlite::params;
    use serde_json::json;

    use crate::Database;

    /// A small PNG; `shade` makes different images.
    fn png(shade: u8) -> Vec<u8> {
        let img = RgbaImage::from_fn(8, 6, |x, y| {
            image::Rgba([shade, x as u8 * 20, y as u8 * 30, 255])
        });
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), 8, 6, ExtendedColorType::Rgba8)
            .unwrap();
        out
    }

    fn image_doc(ids: &[&str]) -> String {
        let mut content = vec![json!({"type":"paragraph","content":[{"type":"text","text":"hi"}]})];
        for id in ids {
            content.push(json!({"type":"image","attrs":{"id":id,"width":null}}));
        }
        json!({"type":"doc","content":content}).to_string()
    }

    fn count(db: &Database, sql: &str) -> i64 {
        db.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn refs(db: &Database, note_id: &str) -> Vec<String> {
        let mut stmt = db
            .conn
            .prepare("SELECT image_id FROM note_images WHERE note_id = ?1 ORDER BY image_id")
            .unwrap();
        stmt.query_map([note_id], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    const PIN: &str = "482913";

    #[test]
    fn add_image_stores_once() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let a = db.add_image(&note.id, &png(10)).unwrap();
        let b = db.add_image(&note.id, &png(10)).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.id.len(), 64);
        assert_eq!((a.width, a.height), (8, 6));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 1);
        assert_eq!(
            count(&db, "SELECT COUNT(*) FROM note_images"),
            0,
            "the reference appears when the note saves"
        );
        let (mime, bytes) = db.image_for_display(&a.id).unwrap().unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(crate::image_prep::image_id(&bytes), a.id);
    }

    #[test]
    fn add_image_refuses_locked_edit_locked_and_missing_notes() {
        let db = Database::open_in_memory().unwrap();
        let private = db.create_note(None).unwrap();
        db.set_private(&private.id, true, "").unwrap();
        db.set_new_pin(PIN).unwrap();
        db.set_privacy_locked(true, &[]);
        assert_eq!(
            db.add_image(&private.id, &png(1)).unwrap_err().code(),
            "private_locked"
        );
        db.set_privacy_locked(false, &[]);

        let edit_locked = db.create_note(None).unwrap();
        db.set_edit_locked(&edit_locked.id, true).unwrap();
        assert_eq!(
            db.add_image(&edit_locked.id, &png(1)).unwrap_err().code(),
            "not_allowed"
        );

        let missing = "2f1c8f0e-6a8b-4c51-9d4e-2b8f5f1a9c3d";
        assert_eq!(
            db.add_image(missing, &png(1)).unwrap_err().code(),
            "not_found"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 0);
    }

    #[test]
    fn add_image_refuses_bad_input_before_storing() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        assert_eq!(
            db.add_image(&note.id, b"not an image").unwrap_err().code(),
            "image_unsupported"
        );
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 0);
    }

    #[test]
    fn save_content_records_references() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let img = db.add_image(&note.id, &png(20)).unwrap();
        db.save_content(&note.id, &image_doc(&[&img.id, &img.id]))
            .unwrap();
        assert_eq!(refs(&db, &note.id), vec![img.id.clone()]);

        db.save_content(&note.id, &image_doc(&[])).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM note_images"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 1);
    }

    #[test]
    fn unknown_image_id_is_saved_not_refused() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let unknown = "b".repeat(64);
        db.save_content(&note.id, &image_doc(&[&unknown])).unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM note_images"), 0);
        let stored = db.get_note(&note.id).unwrap().content;
        assert_eq!(stored["content"][1]["attrs"]["id"], unknown);
    }

    #[test]
    fn failed_save_leaves_references_alone() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let img = db.add_image(&note.id, &png(30)).unwrap();
        db.save_content(&note.id, &image_doc(&[&img.id])).unwrap();
        db.set_edit_locked(&note.id, true).unwrap();
        assert!(db.save_content(&note.id, &image_doc(&[])).is_err());
        assert!(db.save_content(&note.id, "{\"type\":\"nope\"}").is_err());
        assert_eq!(refs(&db, &note.id), vec![img.id]);
    }

    #[test]
    fn duplicate_shares_images() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let img = db.add_image(&note.id, &png(40)).unwrap();
        db.save_content(&note.id, &image_doc(&[&img.id])).unwrap();
        let copy = db.duplicate_note(&note.id).unwrap();
        assert_ne!(copy.id, note.id);
        assert_eq!(refs(&db, &copy.id), vec![img.id.clone()]);
        assert_eq!(refs(&db, &note.id), vec![img.id]);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 1);
    }

    #[test]
    fn purge_never_deletes_images() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_note(None).unwrap();
        let b = db.create_note(None).unwrap();
        let img = db.add_image(&a.id, &png(50)).unwrap();
        db.save_content(&a.id, &image_doc(&[&img.id])).unwrap();
        db.save_content(&b.id, &image_doc(&[&img.id])).unwrap();

        db.save_content(&a.id, &image_doc(&[])).unwrap();
        db.trash_note(&b.id).unwrap();
        db.purge_note(&b.id).unwrap();

        assert_eq!(count(&db, "SELECT COUNT(*) FROM note_images"), 0);
        assert!(db.image_for_display(&img.id).unwrap().is_some());
    }

    #[test]
    fn remove_unused_images_keeps_trashed_and_archived() {
        let db = Database::open_in_memory().unwrap();
        let trashed = db.create_note(None).unwrap();
        let archived = db.create_note(None).unwrap();
        let unused = db.create_note(None).unwrap();
        let t = db.add_image(&trashed.id, &png(60)).unwrap();
        let r = db.add_image(&archived.id, &png(61)).unwrap();
        let u = db.add_image(&unused.id, &png(62)).unwrap();
        db.save_content(&trashed.id, &image_doc(&[&t.id])).unwrap();
        db.save_content(&archived.id, &image_doc(&[&r.id])).unwrap();
        db.trash_note(&trashed.id).unwrap();
        db.set_archived(&archived.id, true).unwrap();

        assert_eq!(db.remove_unused_images().unwrap(), 1);
        assert!(db.image_for_display(&t.id).unwrap().is_some());
        assert!(db.image_for_display(&r.id).unwrap().is_some());
        assert!(db.image_for_display(&u.id).unwrap().is_none());
        assert_eq!(db.remove_unused_images().unwrap(), 0);
    }

    #[test]
    fn image_for_display_respects_the_lock() {
        let db = Database::open_in_memory().unwrap();
        let private = db.create_note(None).unwrap();
        let plain = db.create_note(None).unwrap();
        let img = db.add_image(&private.id, &png(70)).unwrap();
        db.save_content(&private.id, &image_doc(&[&img.id]))
            .unwrap();
        db.set_private(&private.id, true, "").unwrap();
        db.set_new_pin(PIN).unwrap();

        db.set_privacy_locked(true, &[]);
        assert!(db.image_for_display(&img.id).unwrap().is_none());

        db.set_privacy_locked(false, &[]);
        assert!(db.image_for_display(&img.id).unwrap().is_some());

        db.save_content(&plain.id, &image_doc(&[&img.id])).unwrap();
        db.set_privacy_locked(true, &[]);
        assert!(db.image_for_display(&img.id).unwrap().is_some());

        db.set_privacy_locked(false, &[]);
        assert!(db.image_for_display("../x").unwrap().is_none());
        assert!(
            db.image_for_display(&img.id.to_uppercase())
                .unwrap()
                .is_none()
        );
        assert!(db.image_for_display(&"c".repeat(64)).unwrap().is_none());
    }

    #[test]
    fn an_unreferenced_image_is_served_while_locked() {
        let db = Database::open_in_memory().unwrap();
        let plain = db.create_note(None).unwrap();
        let private = db.create_note(None).unwrap();
        // Pasted but not saved yet, or removed from the note (undo can bring it back).
        let fresh = db.add_image(&plain.id, &png(100)).unwrap();
        // Used only by a private note.
        let secret = db.add_image(&private.id, &png(101)).unwrap();
        db.save_content(&private.id, &image_doc(&[&secret.id]))
            .unwrap();
        db.set_private(&private.id, true, "").unwrap();
        db.set_new_pin(PIN).unwrap();

        db.set_privacy_locked(true, &[]);
        assert!(db.image_for_display(&fresh.id).unwrap().is_some());
        assert!(db.image_for_display(&secret.id).unwrap().is_none());
    }

    #[test]
    fn a_kept_open_private_note_keeps_its_image_readable() {
        let db = Database::open_in_memory().unwrap();
        let private = db.create_note(None).unwrap();
        let img = db.add_image(&private.id, &png(80)).unwrap();
        db.save_content(&private.id, &image_doc(&[&img.id]))
            .unwrap();
        db.set_private(&private.id, true, "").unwrap();
        db.set_new_pin(PIN).unwrap();
        db.set_privacy_locked(true, std::slice::from_ref(&private.id));
        assert!(db.image_for_display(&img.id).unwrap().is_some());
    }

    #[test]
    fn deleting_a_note_removes_only_its_references() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_note(None).unwrap();
        let img = db.add_image(&note.id, &png(90)).unwrap();
        db.save_content(&note.id, &image_doc(&[&img.id])).unwrap();
        db.conn
            .execute("DELETE FROM notes WHERE id = ?1", params![note.id])
            .unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM note_images"), 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM images"), 1);
    }
}
