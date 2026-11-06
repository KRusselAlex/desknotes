//! Reading a pasted image from the system clipboard in Rust. WebKitGTK gives the page
//! no clipboard images at all (images in notes, DES-23), so a paste the page sees as
//! empty is read here and no image bytes cross the webview.

use tauri::AppHandle;

use crate::error::IpcResult;

/// What the clipboard holds, best first.
pub enum ClipboardContent {
    /// Encoded image bytes (PNG, or another format converted to PNG), not yet checked.
    Image(Vec<u8>),
    /// No image, but text: kept so an image-plus-text clipboard never loses the text.
    Text(String),
    Nothing,
}

/// Reads the clipboard without blocking the main loop: the requests run on the GTK
/// main thread and answer through a channel; converting to PNG happens on a blocking
/// thread. Other platforms return `Nothing` for now.
pub async fn clipboard_image(app: &AppHandle) -> IpcResult<ClipboardContent> {
    #[cfg(target_os = "linux")]
    {
        linux::read(app).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(ClipboardContent::Nothing)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use desknotes_core::image_prep::PrepLimits;
    use desknotes_core::{CoreError, ImageError};
    use gtk::gdk;
    use gtk::gdk_pixbuf::Pixbuf;
    use gtk::glib;
    use tauri::AppHandle;
    use tauri::async_runtime::Sender;

    use super::ClipboardContent;
    use crate::error::{IpcError, IpcResult};

    /// A decoded clipboard image, copied out of its `Pixbuf` (which may not leave the
    /// main thread) so it can be encoded elsewhere.
    struct Pixels {
        bytes: glib::Bytes,
        has_alpha: bool,
        bits: i32,
        width: i32,
        height: i32,
        rowstride: i32,
    }

    enum Found {
        Png(Vec<u8>),
        Pixels(Pixels),
        Text(String),
        Nothing,
        TooLarge,
    }

    fn image_error(e: ImageError) -> IpcError {
        CoreError::Image(e).into()
    }

    pub async fn read(app: &AppHandle) -> IpcResult<ClipboardContent> {
        let (tx, mut rx) = tauri::async_runtime::channel::<Found>(1);
        app.run_on_main_thread(move || request(tx))?;
        let found = rx
            .recv()
            .await
            .ok_or_else(|| IpcError::new("internal", "the clipboard did not answer"))?;
        match found {
            Found::Png(bytes) => Ok(ClipboardContent::Image(bytes)),
            Found::Pixels(pixels) => tauri::async_runtime::spawn_blocking(move || encode(pixels))
                .await
                .map_err(|e| IpcError::new("internal", e.to_string()))?
                .map(ClipboardContent::Image),
            Found::Text(text) => Ok(ClipboardContent::Text(text)),
            Found::Nothing => Ok(ClipboardContent::Nothing),
            Found::TooLarge => Err(image_error(ImageError::TooLarge)),
        }
    }

    /// On the main thread: `image/png` as it is, else any image GTK can read, else
    /// the text. Each request is asynchronous; the main loop keeps running meanwhile.
    fn request(tx: Sender<Found>) {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        clipboard.request_contents(&gdk::Atom::intern("image/png"), move |clipboard, data| {
            let len = data.length();
            if len > 0 {
                let found = if len as u64 > PrepLimits::DEFAULT.max_input as u64 {
                    Found::TooLarge
                } else {
                    Found::Png(data.data())
                };
                let _ = tx.try_send(found);
                return;
            }
            clipboard.request_image(move |clipboard, pixbuf| {
                if let Some(pixbuf) = pixbuf {
                    let _ = tx.try_send(pixels_of(pixbuf));
                    return;
                }
                clipboard.request_text(move |_, text| {
                    let found = match text {
                        Some(t) if !t.is_empty() => Found::Text(t.to_owned()),
                        _ => Found::Nothing,
                    };
                    let _ = tx.try_send(found);
                });
            });
        });
    }

    /// Copies the pixels out, unless the image has more than the core would ever decode.
    fn pixels_of(pixbuf: &Pixbuf) -> Found {
        let (width, height) = (pixbuf.width(), pixbuf.height());
        let count = u64::try_from(width).unwrap_or(0) * u64::try_from(height).unwrap_or(0);
        if count == 0 {
            return Found::Nothing;
        }
        if count > PrepLimits::DEFAULT.max_pixels {
            return Found::TooLarge;
        }
        Found::Pixels(Pixels {
            bytes: pixbuf.read_pixel_bytes(),
            has_alpha: pixbuf.has_alpha(),
            bits: pixbuf.bits_per_sample(),
            width,
            height,
            rowstride: pixbuf.rowstride(),
        })
    }

    /// Off the main thread: PNG bytes for the core, which checks and re-encodes them.
    fn encode(p: Pixels) -> IpcResult<Vec<u8>> {
        let pixbuf = Pixbuf::from_bytes(
            &p.bytes,
            gtk::gdk_pixbuf::Colorspace::Rgb,
            p.has_alpha,
            p.bits,
            p.width,
            p.height,
            p.rowstride,
        );
        pixbuf
            .save_to_bufferv("png", &[])
            .map_err(|_| image_error(ImageError::Unreadable))
    }
}
