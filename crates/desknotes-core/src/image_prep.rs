//! Image preparation for notes (design: images in notes §3). Pure: bytes in, bytes out.
//!
//! Every image is decoded and re-encoded here, so nothing the user picked is stored
//! as-is: EXIF, GPS, comments and colour profiles are never copied. No SQL, no files.

use std::io::Cursor;

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{
    AnimationDecoder, DynamicImage, ExtendedColorType, ImageDecoder, ImageEncoder, ImageFormat,
    ImageReader, Limits,
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
}

impl PrepLimits {
    pub const DEFAULT: PrepLimits = PrepLimits {
        max_input: 40 * 1024 * 1024,
        max_output: 5 * 1024 * 1024,
        max_side: 2000,
        max_pixels: 100_000_000,
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
        "image/gif" => ImageFormat::Gif,
        _ => ImageFormat::WebP,
    };

    // Dimensions come from the header alone, before any pixel is allocated.
    let (width, height) = header_dimensions(input, format, mime)?;
    if u64::from(width) * u64::from(height) > limits.max_pixels {
        return Err(ImageError::TooLarge.into());
    }

    if format == ImageFormat::Gif
        && let Some(animated) = animated_gif(input, width, height, limits)?
    {
        return finish(animated, "image/gif", width, height, limits);
    }

    let img = decode(input, format, limits)?;
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

/// Re-encodes a GIF with two or more frames, frame by frame and unscaled.
/// Returns `None` for a still GIF. The frames of all decoded pixels together are held
/// to `max_pixels`, so a small file with thousands of big frames cannot exhaust memory.
fn animated_gif(
    input: &[u8],
    width: u32,
    height: u32,
    limits: &PrepLimits,
) -> CoreResult<Option<Vec<u8>>> {
    let decoder = GifDecoder::new(Cursor::new(input)).map_err(map_err)?;
    let per_frame = u64::from(width) * u64::from(height);
    let mut frames = Vec::new();
    for frame in decoder.into_frames() {
        frames.push(frame.map_err(map_err)?);
        if per_frame.saturating_mul(frames.len() as u64) > limits.max_pixels {
            return Err(ImageError::TooLarge.into());
        }
    }
    if frames.len() < 2 {
        return Ok(None);
    }
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut out);
        encoder
            .set_repeat(Repeat::Infinite)
            .map_err(|_| CoreError::from(ImageError::Unreadable))?;
        encoder
            .encode_frames(frames)
            .map_err(|_| CoreError::from(ImageError::Unreadable))?;
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;
    use image::codecs::png::PngEncoder;
    use image::codecs::webp::WebPEncoder;
    use image::{Delay, Frame, Rgb, RgbImage, Rgba, RgbaImage};

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
