//! Reading a pasted image from the system clipboard in Rust. WebKitGTK gives the page
//! no clipboard images at all (images in notes, DES-23), so a paste the page sees as
//! empty is read here and no image bytes cross the webview.

use tauri::AppHandle;

use crate::error::IpcResult;

/// What the clipboard holds, best first.
pub enum ClipboardContent {
    /// Image bytes in a format the core reads (PNG, JPEG, GIF, WebP), not yet checked.
    Image(Vec<u8>),
    /// No image, but text: kept so an image-plus-text clipboard never loses the text.
    Text(String),
    Nothing,
}

/// Reads the clipboard without blocking the main loop: the GTK requests run on the main
/// thread and answer through a channel; nothing is decoded there. Other platforms
/// return `Nothing` for now.
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

/// Image types in the order they are asked for: PNG (screenshots), then the other
/// formats the core reads as they are, then BMP and TIFF, which are converted.
const PREFERRED_TARGETS: [&str; 7] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-bmp",
    "image/tiff",
];

/// The clipboard target to fetch an image from: the first preferred type offered, else
/// any other `image/…` type except SVG (never accepted). `None` without an image.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn choose_image_target(offered: &[String]) -> Option<String> {
    let lower: Vec<String> = offered.iter().map(|t| t.to_ascii_lowercase()).collect();
    PREFERRED_TARGETS
        .iter()
        .find_map(|want| lower.iter().position(|t| t == want))
        .or_else(|| {
            lower
                .iter()
                .position(|t| t.starts_with("image/") && !t.starts_with("image/svg"))
        })
        .map(|i| offered[i].clone())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::Cell;
    use std::rc::Rc;

    use desknotes_core::image_prep::{PrepLimits, sniff_mime};
    use desknotes_core::{CoreError, ImageError};
    use gtk::gdk;
    use gtk::gdk_pixbuf::PixbufLoader;
    use gtk::gdk_pixbuf::prelude::*;
    use tauri::AppHandle;
    use tauri::async_runtime::Sender;

    use super::{ClipboardContent, choose_image_target};
    use crate::error::{IpcError, IpcResult};

    enum Found {
        Image(Vec<u8>),
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
            Found::Image(bytes) => {
                tauri::async_runtime::spawn_blocking(move || to_core_image(bytes))
                    .await
                    .map_err(|e| IpcError::new("internal", e.to_string()))?
                    .map(ClipboardContent::Image)
            }
            Found::Text(text) => Ok(ClipboardContent::Text(text)),
            Found::Nothing => Ok(ClipboardContent::Nothing),
            Found::TooLarge => Err(image_error(ImageError::TooLarge)),
        }
    }

    /// On the main thread, all asynchronous: ask which types the clipboard offers
    /// (as `gtk_clipboard_request_targets` does), fetch the chosen image type's bytes
    /// as they are (refusing over the input limit before copying them), and fall back
    /// to the text when there is no image. Nothing is decoded here.
    fn request(tx: Sender<Found>) {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, data| {
            let offered: Vec<String> = data
                .targets()
                .unwrap_or_default()
                .into_iter()
                .map(|atom| atom.name().to_string())
                .collect();
            let Some(target) = choose_image_target(&offered) else {
                request_text(clipboard, tx);
                return;
            };
            clipboard.request_contents(&gdk::Atom::intern(&target), move |clipboard, data| {
                let len = data.length();
                if len <= 0 {
                    request_text(clipboard, tx);
                    return;
                }
                let found = if len as u64 > PrepLimits::DEFAULT.max_input as u64 {
                    Found::TooLarge
                } else {
                    Found::Image(data.data())
                };
                let _ = tx.try_send(found);
            });
        });
    }

    fn request_text(clipboard: &gtk::Clipboard, tx: Sender<Found>) {
        clipboard.request_text(move |_, text| {
            let found = match text {
                Some(t) if !t.is_empty() => Found::Text(t.to_owned()),
                _ => Found::Nothing,
            };
            let _ = tx.try_send(found);
        });
    }

    /// Off the main thread: bytes the core reads are passed on as they are; anything
    /// else (BMP, TIFF…) is decoded with gdk-pixbuf and re-encoded as PNG. A declared
    /// size over the core's pixel limit stops the decoder before it allocates.
    pub fn to_core_image(bytes: Vec<u8>) -> IpcResult<Vec<u8>> {
        if sniff_mime(&bytes).is_some() {
            return Ok(bytes);
        }
        let loader = PixbufLoader::new();
        let too_large = Rc::new(Cell::new(false));
        let flag = too_large.clone();
        loader.connect_size_prepared(move |loader, width, height| {
            let count = u64::try_from(width).unwrap_or(0) * u64::try_from(height).unwrap_or(0);
            if count > PrepLimits::DEFAULT.max_pixels {
                flag.set(true);
                // Size 0 asks the decoder to stop, as `gdk_pixbuf_get_file_info` does.
                loader.set_size(0, 0);
            }
        });
        let written = loader.write(&bytes);
        let closed = loader.close();
        if too_large.get() {
            return Err(image_error(ImageError::TooLarge));
        }
        let pixbuf = match (written, closed) {
            (Ok(()), Ok(())) => loader.pixbuf(),
            _ => None,
        }
        .ok_or_else(|| image_error(ImageError::Unsupported))?;
        pixbuf
            .save_to_bufferv("png", &[])
            .map_err(|_| image_error(ImageError::Unreadable))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn png_is_chosen_first_whatever_the_order() {
        let offered = targets(&[
            "TARGETS",
            "image/bmp",
            "image/jpeg",
            "image/png",
            "text/plain",
        ]);
        assert_eq!(choose_image_target(&offered).as_deref(), Some("image/png"));
    }

    #[test]
    fn then_formats_the_core_reads_then_bmp_and_tiff() {
        assert_eq!(
            choose_image_target(&targets(&["image/tiff", "image/webp", "image/gif"])).as_deref(),
            Some("image/gif")
        );
        assert_eq!(
            choose_image_target(&targets(&["image/tiff", "image/jpeg"])).as_deref(),
            Some("image/jpeg")
        );
        assert_eq!(
            choose_image_target(&targets(&["image/tiff", "image/bmp"])).as_deref(),
            Some("image/bmp")
        );
    }

    #[test]
    fn any_other_raster_image_type_is_a_last_resort_but_never_svg() {
        assert_eq!(
            choose_image_target(&targets(&["image/svg+xml", "image/x-ico"])).as_deref(),
            Some("image/x-ico")
        );
        assert_eq!(choose_image_target(&targets(&["image/svg+xml"])), None);
    }

    #[test]
    fn no_image_target_means_none() {
        assert_eq!(
            choose_image_target(&targets(&[
                "TARGETS",
                "text/plain",
                "text/html",
                "UTF8_STRING"
            ])),
            None
        );
        assert_eq!(choose_image_target(&[]), None);
    }

    #[cfg(target_os = "linux")]
    mod conversion {
        use super::super::linux::to_core_image;

        const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

        /// A 24-bit BMP of `width` x `height` declared in its header, with `pixels`
        /// bytes of pixel data following it.
        fn bmp(width: i32, height: i32, pixels: usize) -> Vec<u8> {
            let size = 54 + pixels as u32;
            let mut b = Vec::new();
            b.extend_from_slice(b"BM");
            b.extend_from_slice(&size.to_le_bytes());
            b.extend_from_slice(&[0; 4]);
            b.extend_from_slice(&54u32.to_le_bytes());
            b.extend_from_slice(&40u32.to_le_bytes());
            b.extend_from_slice(&width.to_le_bytes());
            b.extend_from_slice(&height.to_le_bytes());
            b.extend_from_slice(&1u16.to_le_bytes());
            b.extend_from_slice(&24u16.to_le_bytes());
            b.extend_from_slice(&[0; 4]); // no compression
            b.extend_from_slice(&(pixels as u32).to_le_bytes());
            b.extend_from_slice(&[0; 16]);
            b.extend(std::iter::repeat_n(0x7f, pixels));
            b
        }

        #[test]
        fn bytes_the_core_reads_are_passed_on_untouched() {
            let mut png = PNG_SIGNATURE.to_vec();
            png.extend_from_slice(b"rest");
            assert_eq!(to_core_image(png.clone()).unwrap(), png);
            let jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 1, 2];
            assert_eq!(to_core_image(jpeg.clone()).unwrap(), jpeg);
        }

        #[test]
        fn a_bmp_is_converted_to_png() {
            // 2 x 2, each row 6 bytes padded to 8.
            let out = to_core_image(bmp(2, 2, 16)).unwrap();
            assert!(
                out.starts_with(&PNG_SIGNATURE),
                "{:?}",
                &out[..8.min(out.len())]
            );
        }

        #[test]
        fn a_huge_declared_size_is_refused_before_decoding() {
            let err = to_core_image(bmp(20_000, 20_000, 16)).unwrap_err();
            assert_eq!(err.code, "image_too_large");
        }

        #[test]
        fn bytes_no_decoder_reads_are_unsupported() {
            let err = to_core_image(b"not an image at all".to_vec()).unwrap_err();
            assert_eq!(err.code, "image_unsupported");
        }
    }
}
