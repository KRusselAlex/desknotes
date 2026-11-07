//! Image preparation for notes (design: images in notes §3). Pure: bytes in, bytes out.
//!
//! Every image is decoded and re-encoded here, so nothing the user picked is stored
//! as-is: EXIF, GPS, comments and colour profiles are never copied. No SQL, no files.

use std::borrow::Cow;
use std::io::{Cursor, Read};
use std::num::NonZeroU64;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
    Rgba, RgbaImage,
};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult, ImageError};

/// JPEG quality for every JPEG this module writes.
const JPEG_QUALITY: u8 = 85;

/// Size rules. `DEFAULT` holds the shipped values; tests use smaller ones.
#[derive(Debug, Clone, Copy)]
pub struct PrepLimits {
    /// Largest input file accepted, checked before any decoding.
    pub max_input: usize,
    /// Largest stored result.
    pub max_output: usize,
    /// Longest side after scaling (animated GIFs are never scaled).
    pub max_side: u32,
    /// Most pixels a decoder may be asked to produce.
    pub max_pixels: u64,
    /// Most pixels an animated GIF may hold, summed over every frame's own rectangle,
    /// so a small file with thousands of frames cannot keep the decoder busy for ever.
    pub max_animation_pixels: u64,
}

impl PrepLimits {
    pub const DEFAULT: PrepLimits = PrepLimits {
        max_input: 40 * 1024 * 1024,
        max_output: 5 * 1024 * 1024,
        max_side: 2000,
        max_pixels: 100_000_000,
        max_animation_pixels: 1_000_000_000,
    };
}

/// An image ready to store. `id` is the lowercase hex SHA-256 of `bytes`.
#[derive(Debug, Clone)]
pub struct PreparedImage {
    pub id: String,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

pub fn prepare_image(input: &[u8]) -> CoreResult<PreparedImage> {
    prepare_image_with(input, &PrepLimits::DEFAULT)
}

pub fn prepare_image_with(input: &[u8], limits: &PrepLimits) -> CoreResult<PreparedImage> {
    // Size first, so a huge file is never looked at (design §3).
    if input.len() > limits.max_input {
        return Err(ImageError::TooLarge.into());
    }
    let mime = sniff_mime(input).ok_or(ImageError::Unsupported)?;
    let format = match mime {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/gif" => {
            return match read_gif(input, limits)? {
                Gif::Animated {
                    bytes,
                    width,
                    height,
                } => finish(bytes, "image/gif", width, height, limits),
                Gif::Still(img) => still(img, mime, limits),
            };
        }
        _ => ImageFormat::WebP,
    };

    // Dimensions come from the header alone, before any pixel is allocated.
    let (width, height) = header_dimensions(input, format, mime)?;
    if u64::from(width) * u64::from(height) > limits.max_pixels {
        return Err(ImageError::TooLarge.into());
    }

    let img = decode(input, format, limits)?;
    still(img, mime, limits)
}

/// Scales a decoded still image and encodes it: JPEG stays JPEG, everything else
/// becomes PNG, or JPEG when an opaque PNG would be over the size cap.
fn still(img: DynamicImage, mime: &str, limits: &PrepLimits) -> CoreResult<PreparedImage> {
    let img = shrink(img, limits.max_side);
    let (width, height) = (img.width(), img.height());

    if mime == "image/jpeg" {
        return finish(encode_jpeg(&img)?, "image/jpeg", width, height, limits);
    }
    let png = encode_png(&img)?;
    if png.len() <= limits.max_output || has_transparency(&img) {
        return finish(png, "image/png", width, height, limits);
    }
    // Opaque and still too big as PNG: a JPEG is the only way to get it under the cap.
    finish(encode_jpeg(&img)?, "image/jpeg", width, height, limits)
}

pub fn image_id(bytes: &[u8]) -> String {
    use std::fmt::Write;
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        })
}

/// The image type from the file's first bytes (never the name), or `None`.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Final size check and the hash, shared by every output path.
fn finish(
    bytes: Vec<u8>,
    mime: &'static str,
    width: u32,
    height: u32,
    limits: &PrepLimits,
) -> CoreResult<PreparedImage> {
    if bytes.len() > limits.max_output {
        return Err(ImageError::TooLarge.into());
    }
    Ok(PreparedImage {
        id: image_id(&bytes),
        mime,
        width,
        height,
        bytes,
    })
}

/// Maps a decoder error: a limit error means "too large", anything else "damaged".
fn map_err(e: image::ImageError) -> CoreError {
    match e {
        image::ImageError::Limits(_) => ImageError::TooLarge.into(),
        _ => ImageError::Unreadable.into(),
    }
}

fn decode_limits(limits: &PrepLimits) -> Limits {
    let side = u32::try_from(limits.max_pixels).unwrap_or(u32::MAX);
    let mut l = Limits::default();
    l.max_image_width = Some(side);
    l.max_image_height = Some(side);
    // Room for one 16-bit RGBA copy of the biggest allowed image.
    l.max_alloc = Some(limits.max_pixels.saturating_mul(8));
    l
}

/// Width and height read from the header only. A PNG that stops after its IHDR still
/// has its size read here, so a "tiny file, huge size" input is refused as too large
/// rather than reported as damaged.
fn header_dimensions(input: &[u8], format: ImageFormat, mime: &str) -> CoreResult<(u32, u32)> {
    if mime == "image/png" && input.len() >= 24 && &input[12..16] == b"IHDR" {
        let w = u32::from_be_bytes([input[16], input[17], input[18], input[19]]);
        let h = u32::from_be_bytes([input[20], input[21], input[22], input[23]]);
        if w == 0 || h == 0 {
            return Err(ImageError::Unreadable.into());
        }
        return Ok((w, h));
    }
    ImageReader::with_format(Cursor::new(input), format)
        .into_dimensions()
        .map_err(map_err)
}

/// Decodes a still image, applying the EXIF orientation (it is dropped with the
/// metadata, so the pixels must carry it).
fn decode(input: &[u8], format: ImageFormat, limits: &PrepLimits) -> CoreResult<DynamicImage> {
    let mut decoder = ImageReader::with_format(Cursor::new(input), format)
        .into_decoder()
        .map_err(map_err)?;
    decoder.set_limits(decode_limits(limits)).map_err(map_err)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(map_err)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn shrink(img: DynamicImage, max_side: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_side {
        return img;
    }
    // `resize` keeps the aspect ratio and fits inside max_side x max_side.
    img.resize(max_side, max_side, FilterType::Lanczos3)
}

/// An alpha channel only counts if some pixel is actually not opaque.
fn has_transparency(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

fn encode_png(img: &DynamicImage) -> CoreResult<Vec<u8>> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|_| CoreError::from(ImageError::Unreadable))?;
    Ok(out)
}

fn encode_jpeg(img: &DynamicImage) -> CoreResult<Vec<u8>> {
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|_| CoreError::from(ImageError::Unreadable))?;
    Ok(out)
}

/// A GIF after reading: a re-encoded animation, or the only frame of a still one.
enum Gif {
    Animated {
        bytes: Vec<u8>,
        width: u32,
        height: u32,
    },
    Still(DynamicImage),
}

/// Maps a `gif` decoder error: running into the memory limit means "too large".
fn gif_err(e: gif::DecodingError) -> CoreError {
    match e {
        gif::DecodingError::MemoryLimit | gif::DecodingError::OutOfMemory => {
            ImageError::TooLarge.into()
        }
        _ => ImageError::Unreadable.into(),
    }
}

fn gif_encode_err(_: gif::EncodingError) -> CoreError {
    ImageError::Unreadable.into()
}

/// Reads a GIF in indexed form, in one pass. Two or more frames are copied losslessly,
/// frame by frame and unscaled: each frame keeps its own rectangle, local palette,
/// transparent index, delay and disposal, with the global palette, screen size and loop
/// count. Nothing else is written, so comments, XMP and other application extensions
/// are dropped. A GIF with one frame comes back as pixels for the still-image path.
fn read_gif(input: &[u8], limits: &PrepLimits) -> CoreResult<Gif> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    // Indexed frames take one byte per pixel.
    let per_frame = NonZeroU64::new(limits.max_pixels).ok_or(ImageError::TooLarge)?;
    options.set_memory_limit(gif::MemoryLimit::Bytes(per_frame));
    let mut decoder = options.read_info(Cursor::new(input)).map_err(gif_err)?;

    // The logical screen comes from the header alone, before any frame is read.
    let (width, height) = (decoder.width(), decoder.height());
    if width == 0 || height == 0 {
        return Err(ImageError::Unreadable.into());
    }
    if u64::from(width) * u64::from(height) > limits.max_pixels {
        return Err(ImageError::TooLarge.into());
    }
    let global = decoder.global_palette().unwrap_or_default().to_vec();
    let mut budget = limits.max_animation_pixels;

    let first = next_gif_frame(&mut decoder, limits, &mut budget)?.ok_or(ImageError::Unreadable)?;
    let Some(second) = next_gif_frame(&mut decoder, limits, &mut budget)? else {
        return Ok(Gif::Still(gif_still(&first, &global, width, height)));
    };

    // The loop extension sits before the first frame, so it has been read by now.
    let repeat = decoder.repeat();
    let mut encoder =
        gif::Encoder::new(Vec::new(), width, height, &global).map_err(gif_encode_err)?;
    encoder.set_repeat(repeat).map_err(gif_encode_err)?;
    encoder.write_frame(&first).map_err(gif_encode_err)?;
    drop(first);
    encoder.write_frame(&second).map_err(gif_encode_err)?;
    drop(second);
    while let Some(frame) = next_gif_frame(&mut decoder, limits, &mut budget)? {
        encoder.write_frame(&frame).map_err(gif_encode_err)?;
        // Stop as soon as the result cannot fit, instead of finishing a doomed file.
        if encoder.get_ref().len() > limits.max_output {
            return Err(ImageError::TooLarge.into());
        }
    }
    let bytes = encoder.into_inner().map_err(gif_encode_err)?;
    Ok(Gif::Animated {
        bytes,
        width: u32::from(width),
        height: u32::from(height),
    })
}

/// The next frame with its indexed pixels, or `None` after the last one. Each frame's
/// area is counted against `budget` before its pixels are decoded.
fn next_gif_frame<R: Read>(
    decoder: &mut gif::Decoder<R>,
    limits: &PrepLimits,
    budget: &mut u64,
) -> CoreResult<Option<gif::Frame<'static>>> {
    let Some(info) = decoder.next_frame_info().map_err(gif_err)? else {
        return Ok(None);
    };
    let area = u64::from(info.width) * u64::from(info.height);
    if area > limits.max_pixels {
        return Err(ImageError::TooLarge.into());
    }
    *budget = budget.checked_sub(area).ok_or(ImageError::TooLarge)?;
    let mut frame = gif::Frame {
        buffer: Cow::Borrowed(&[]),
        palette: info.palette.clone(),
        // The decoder hands back de-interlaced rows, so they are written as such.
        interlaced: false,
        ..*info
    };
    let len = usize::try_from(area).map_err(|_| ImageError::TooLarge)?;
    let mut pixels = vec![0u8; len];
    decoder.read_into_buffer(&mut pixels).map_err(gif_err)?;
    frame.buffer = Cow::Owned(pixels);
    Ok(Some(frame))
}

/// The only frame of a still GIF placed on its transparent screen, the way browsers
/// show it. Parts of the frame outside the screen are cut off.
fn gif_still(frame: &gif::Frame<'_>, global: &[u8], width: u16, height: u16) -> DynamicImage {
    let palette = frame.palette.as_deref().unwrap_or(global);
    let mut canvas = RgbaImage::new(u32::from(width), u32::from(height));
    let frame_width = usize::from(frame.width);
    for (row, line) in frame.buffer.chunks_exact(frame_width.max(1)).enumerate() {
        let y = u32::from(frame.top) + row as u32;
        if y >= u32::from(height) {
            break;
        }
        for (col, &index) in line.iter().enumerate() {
            let x = u32::from(frame.left) + col as u32;
            if x >= u32::from(width) {
                break;
            }
            if frame.transparent == Some(index) {
                continue;
            }
            let at = usize::from(index) * 3;
            if let Some(rgb) = palette.get(at..at + 3) {
                canvas.put_pixel(x, y, Rgba([rgb[0], rgb[1], rgb[2], 255]));
            }
        }
    }
    DynamicImage::ImageRgba8(canvas)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
    use image::codecs::png::PngEncoder;
    use image::codecs::webp::WebPEncoder;
    use image::{AnimationDecoder, Delay, Frame, Rgb, RgbImage};

    fn png_of(img: &RgbaImage) -> Vec<u8> {
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        out
    }

    fn jpeg_of(img: &RgbImage) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 90)
            .write_image(
                img.as_raw(),
                img.width(),
                img.height(),
                ExtendedColorType::Rgb8,
            )
            .unwrap();
        out
    }

    /// Deterministic noise that compresses badly (no `rand` dependency).
    fn noise(width: u32, height: u32) -> RgbImage {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        RgbImage::from_fn(width, height, |_, _| {
            let mut next = || {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            };
            Rgb([next(), next(), next()])
        })
    }

    fn error_of(r: CoreResult<PreparedImage>) -> ImageError {
        match r {
            Err(CoreError::Image(e)) => e,
            other => panic!("expected an image error, got {other:?}"),
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn png_keeps_size_and_becomes_png() {
        let src = RgbaImage::from_pixel(300, 200, Rgba([10, 20, 30, 128]));
        let out = prepare_image(&png_of(&src)).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (300, 200));
        assert_eq!(out.id, image_id(&out.bytes));
        assert_eq!(out.id.len(), 64);
        assert!(
            out.id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }

    #[test]
    fn image_id_is_sha256_hex() {
        assert_eq!(
            image_id(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn large_photo_is_scaled_to_2000() {
        let src = RgbImage::from_pixel(4000, 3000, Rgb([200, 100, 50]));
        let out = prepare_image(&jpeg_of(&src)).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert_eq!((out.width, out.height), (2000, 1500));
    }

    #[test]
    fn exif_and_gps_are_removed() {
        let jpeg = jpeg_of(&RgbImage::from_pixel(64, 48, Rgb([1, 2, 3])));
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(b"GPSLatitude 48.85 GPSLongitude 2.35");
        let mut tagged = jpeg[..2].to_vec(); // SOI
        tagged.extend_from_slice(&[0xFF, 0xE1]);
        tagged.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(&payload);
        tagged.extend_from_slice(&jpeg[2..]);
        assert!(contains(&tagged, b"Exif") && contains(&tagged, b"GPS"));

        let out = prepare_image(&tagged).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert!(!contains(&out.bytes, b"Exif"));
        assert!(!contains(&out.bytes, b"GPS"));
    }

    #[test]
    fn exif_orientation_is_applied_before_the_metadata_is_dropped() {
        let jpeg = jpeg_of(&RgbImage::from_pixel(64, 48, Rgb([1, 2, 3])));
        // Big-endian TIFF with one entry: Orientation (0x0112) = 6 (rotate 90 clockwise).
        let mut payload = b"Exif\0\0MM\0*\0\0\0\x08\0\x01".to_vec();
        payload.extend_from_slice(&[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
        let mut tagged = jpeg[..2].to_vec();
        tagged.extend_from_slice(&[0xFF, 0xE1]);
        tagged.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        tagged.extend_from_slice(&payload);
        tagged.extend_from_slice(&jpeg[2..]);

        let out = prepare_image(&tagged).unwrap();
        assert_eq!((out.width, out.height), (48, 64));
        assert!(!contains(&out.bytes, b"Exif"));
    }

    #[test]
    fn webp_becomes_png() {
        let src = RgbaImage::from_pixel(50, 40, Rgba([5, 6, 7, 255]));
        let mut webp = Vec::new();
        WebPEncoder::new_lossless(&mut webp)
            .write_image(src.as_raw(), 50, 40, ExtendedColorType::Rgba8)
            .unwrap();
        assert_eq!(sniff_mime(&webp), Some("image/webp"));
        let out = prepare_image(&webp).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (50, 40));
    }

    fn gif_with_frames(count: u8) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut enc = GifEncoder::new(&mut out);
            enc.set_repeat(Repeat::Infinite).unwrap();
            for i in 0..count {
                let img = RgbaImage::from_pixel(40, 40, Rgba([i * 100, 50, 200, 255]));
                enc.encode_frame(Frame::from_parts(
                    img,
                    0,
                    0,
                    Delay::from_numer_denom_ms(100, 1),
                ))
                .unwrap();
            }
        }
        out
    }

    #[test]
    fn animated_gif_keeps_its_frames() {
        let out = prepare_image(&gif_with_frames(2)).unwrap();
        assert_eq!(out.mime, "image/gif");
        assert_eq!((out.width, out.height), (40, 40));
        let frames = GifDecoder::new(Cursor::new(&out.bytes))
            .unwrap()
            .into_frames()
            .collect_frames()
            .unwrap();
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn still_gif_becomes_png() {
        let out = prepare_image(&gif_with_frames(1)).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (40, 40));
    }

    /// One frame for the `gif` crate's encoder: a solid rectangle of palette index `idx`.
    fn rect_frame(
        left: u16,
        top: u16,
        width: u16,
        height: u16,
        idx: u8,
        delay: u16,
    ) -> gif::Frame<'static> {
        gif::Frame {
            left,
            top,
            width,
            height,
            delay,
            buffer: std::borrow::Cow::Owned(vec![idx; usize::from(width) * usize::from(height)]),
            ..gif::Frame::default()
        }
    }

    /// Every frame of a GIF as the `gif` crate reads it (indexed), plus the loop count.
    fn read_gif_frames(bytes: &[u8]) -> (Vec<gif::Frame<'static>>, gif::Repeat) {
        let mut opts = gif::DecodeOptions::new();
        opts.set_color_output(gif::ColorOutput::Indexed);
        let mut dec = opts.read_info(Cursor::new(bytes)).unwrap();
        let mut frames = Vec::new();
        while let Some(f) = dec.read_next_frame().unwrap() {
            frames.push(f.clone());
        }
        (frames, dec.repeat())
    }

    const GLOBAL: [u8; 12] = [0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0];

    #[test]
    fn animated_gif_keeps_frame_rectangles_palettes_delays_and_loop() {
        let mut input = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut input, 60, 40, &GLOBAL).unwrap();
            enc.set_repeat(gif::Repeat::Finite(3)).unwrap();
            enc.write_frame(&rect_frame(0, 0, 60, 40, 1, 10)).unwrap();
            let mut second = rect_frame(5, 6, 10, 8, 2, 20);
            second.palette = Some(vec![9, 8, 7, 6, 5, 4, 3, 2, 1, 1, 2, 3]);
            second.transparent = Some(3);
            second.dispose = gif::DisposalMethod::Background;
            enc.write_frame(&second).unwrap();
            enc.write_frame(&rect_frame(30, 20, 7, 3, 3, 30)).unwrap();
        }
        let out = prepare_image(&input).unwrap();
        assert_eq!(out.mime, "image/gif");
        assert_eq!((out.width, out.height), (60, 40));

        let (before, _) = read_gif_frames(&input);
        let (after, repeat) = read_gif_frames(&out.bytes);
        assert_eq!(repeat, gif::Repeat::Finite(3));
        assert_eq!(after.len(), 3);
        for (a, b) in before.iter().zip(&after) {
            assert_eq!(
                (a.left, a.top, a.width, a.height),
                (b.left, b.top, b.width, b.height)
            );
            assert_eq!(a.delay, b.delay);
            assert_eq!(a.transparent, b.transparent);
            assert_eq!(a.dispose, b.dispose);
            assert_eq!(a.palette, b.palette);
            assert_eq!(a.buffer, b.buffer, "indexed pixels are copied losslessly");
        }
        assert_eq!(after[1].palette.as_deref().map(<[u8]>::len), Some(12));
    }

    #[test]
    fn still_gif_frame_is_placed_on_a_transparent_screen() {
        let mut input = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut input, 20, 20, &GLOBAL).unwrap();
            let mut frame = rect_frame(5, 5, 10, 10, 2, 0);
            frame.buffer.to_mut()[0] = 3; // one transparent pixel at (5, 5)
            frame.transparent = Some(3);
            enc.write_frame(&frame).unwrap();
        }
        let out = prepare_image(&input).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (20, 20));
        let img = image::load_from_memory(&out.bytes).unwrap().to_rgba8();
        assert_eq!(
            img.get_pixel(0, 0).0[3],
            0,
            "outside the frame is transparent"
        );
        assert_eq!(
            img.get_pixel(5, 5).0[3],
            0,
            "the transparent index stays clear"
        );
        assert_eq!(img.get_pixel(6, 6).0, [255, 0, 0, 255]);
    }

    #[test]
    fn gif_comment_and_xmp_are_dropped() {
        let mut input = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut input, 20, 20, &GLOBAL).unwrap();
            enc.set_repeat(gif::Repeat::Infinite).unwrap();
            enc.write_raw_extension(gif::AnyExtension(0xFE), &[b"secret comment"])
                .unwrap();
            enc.write_raw_extension(
                gif::AnyExtension(0xFF),
                &[b"XMP DataXMP", b"<x:xmpmeta>GPSLatitude 48.85</x:xmpmeta>"],
            )
            .unwrap();
            enc.write_frame(&rect_frame(0, 0, 20, 20, 1, 5)).unwrap();
            enc.write_frame(&rect_frame(2, 2, 4, 4, 2, 5)).unwrap();
        }
        assert!(contains(&input, b"XMP DataXMP") && contains(&input, &[0x21, 0xFE]));

        let out = prepare_image(&input).unwrap();
        assert_eq!(out.mime, "image/gif");
        assert!(!contains(&out.bytes, b"XMP DataXMP"));
        assert!(!contains(&out.bytes, b"GPSLatitude"));
        assert!(!contains(&out.bytes, b"secret comment"));
        assert!(!contains(&out.bytes, &[0x21, 0xFE]));
        let (_, repeat) = read_gif_frames(&out.bytes);
        assert_eq!(repeat, gif::Repeat::Infinite);
    }

    #[test]
    fn long_animation_is_copied_quickly_and_stays_small() {
        let mut input = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut input, 400, 200, &GLOBAL).unwrap();
            enc.set_repeat(gif::Repeat::Infinite).unwrap();
            enc.write_frame(&rect_frame(0, 0, 400, 200, 0, 4)).unwrap();
            for i in 1..300u16 {
                let (x, y) = ((i * 13) % 380, (i * 7) % 180);
                enc.write_frame(&rect_frame(x, y, 20, 20, (i % 3 + 1) as u8, 4))
                    .unwrap();
            }
        }
        let start = std::time::Instant::now();
        let out = prepare_image(&input).unwrap();
        let took = start.elapsed();
        eprintln!(
            "300-frame 400x200 GIF: {} -> {} bytes in {took:?}",
            input.len(),
            out.bytes.len()
        );
        assert!(took < std::time::Duration::from_secs(2), "took {took:?}");
        assert_eq!(out.mime, "image/gif");
        assert!(out.bytes.len() < 5 * 1024 * 1024);
        assert_eq!(read_gif_frames(&out.bytes).0.len(), 300);
    }

    #[test]
    fn gif_over_the_frame_budget_is_too_large() {
        let mut input = Vec::new();
        {
            let mut enc = gif::Encoder::new(&mut input, 40, 40, &GLOBAL).unwrap();
            for i in 0..10u8 {
                enc.write_frame(&rect_frame(0, 0, 40, 40, i % 4, 5))
                    .unwrap();
            }
        }
        // 10 frames of 40 x 40 = 16 000 pixels, over a 10 000 budget.
        let limits = PrepLimits {
            max_animation_pixels: 10_000,
            ..PrepLimits::DEFAULT
        };
        assert_eq!(
            error_of(prepare_image_with(&input, &limits)),
            ImageError::TooLarge
        );
        assert!(prepare_image(&input).is_ok());
    }

    #[test]
    fn opaque_png_too_big_as_png_is_stored_as_jpeg() {
        let img = DynamicImage::ImageRgba8(DynamicImage::ImageRgb8(noise(200, 200)).to_rgba8());
        let png = png_of(&img.to_rgba8());
        let as_png = encode_png(&img).unwrap().len();
        let as_jpeg = encode_jpeg(&img).unwrap().len();
        assert!(as_jpeg < as_png);
        let limits = PrepLimits {
            max_output: as_jpeg,
            ..PrepLimits::DEFAULT
        };
        let out = prepare_image_with(&png, &limits).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert_eq!((out.width, out.height), (200, 200));
    }

    #[test]
    fn transparent_png_too_big_as_png_is_too_large() {
        let mut rgba = DynamicImage::ImageRgb8(noise(200, 200)).to_rgba8();
        rgba.get_pixel_mut(3, 3).0[3] = 0;
        let limits = PrepLimits {
            max_output: 10 * 1024,
            ..PrepLimits::DEFAULT
        };
        assert_eq!(
            error_of(prepare_image_with(&png_of(&rgba), &limits)),
            ImageError::TooLarge
        );
    }

    #[test]
    fn svg_and_pdf_are_unsupported() {
        let svg =
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\"/></svg>";
        assert_eq!(error_of(prepare_image(svg)), ImageError::Unsupported);
        assert_eq!(
            error_of(prepare_image(b"%PDF-1.7\n1 0 obj\n")),
            ImageError::Unsupported
        );
        assert_eq!(error_of(prepare_image(&[])), ImageError::Unsupported);
    }

    #[test]
    fn damaged_png_is_unreadable() {
        let png = png_of(&RgbaImage::from_pixel(300, 200, Rgba([9, 9, 9, 255])));
        let half = &png[..png.len() / 2];
        assert_eq!(error_of(prepare_image(half)), ImageError::Unreadable);
    }

    #[test]
    fn input_over_limit_is_too_large() {
        let png = png_of(&RgbaImage::from_pixel(300, 200, Rgba([9, 9, 9, 255])));
        let limits = PrepLimits {
            max_input: 1024,
            ..PrepLimits::DEFAULT
        };
        // A valid PNG over 1 KB, and a junk blob over 1 KB, both refused for size first.
        let noisy = png_of(&RgbaImage::from_raw(100, 100, vec![0x5a; 40_000]).unwrap());
        assert!(noisy.len() > 1024 || png.len() > 1024);
        let big = if png.len() > 1024 { &png } else { &noisy };
        assert_eq!(
            error_of(prepare_image_with(big, &limits)),
            ImageError::TooLarge
        );
        assert_eq!(
            error_of(prepare_image_with(&vec![0u8; 2048], &limits)),
            ImageError::TooLarge
        );
    }

    #[test]
    fn still_too_large_after_shrinking() {
        let png = png_of(&image::DynamicImage::ImageRgb8(noise(1000, 1000)).to_rgba8());
        let limits = PrepLimits {
            max_output: 50 * 1024,
            ..PrepLimits::DEFAULT
        };
        assert_eq!(
            error_of(prepare_image_with(&png, &limits)),
            ImageError::TooLarge
        );
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn huge_dimensions_are_refused_without_decoding() {
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(b"IHDR");
        ihdr.extend_from_slice(&50_000u32.to_be_bytes());
        ihdr.extend_from_slice(&50_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        assert_eq!(error_of(prepare_image(&png)), ImageError::TooLarge);
    }
}
