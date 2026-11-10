//! #1135 part 5: the profile photo. What must hold:
//! 1. Only real PNG/JPEG/WebP/GIF bytes are taken (the client's type and name
//!    are ignored; SVG and junk 400 `invalid_image`), at most 1 MiB (413) and
//!    4096 px a side (400, before decoding the pixels).
//! 2. What's stored is WebP, at most 512 px, upright (EXIF orientation
//!    applied), with no metadata left; the key is the server's.
//! 3. Replacing deletes the old file; DELETE clears and deletes it.
//! 4. `GET me/profile` always carries `avatar_url` (null when none).

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex, OnceLock};

use http::header::HeaderValue;
use image::{ImageFormat, RgbaImage};
use serde_json::Value;
use umbral::storage::{Storage, StorageError, StoredFile, async_trait, set_storage};

mod support;
use support::TestApp;

const AVATAR: &str = "/api/taskflow/me/avatar";
const PROFILE: &str = "/api/taskflow/me/profile";

#[derive(Default)]
struct Mem {
    files: Mutex<HashMap<String, Vec<u8>>>,
    deleted: Mutex<Vec<String>>,
}

#[async_trait]
impl Storage for Mem {
    async fn store(&self, filename: &str, _ct: &str, bytes: &[u8]) -> Result<StoredFile, StorageError> {
        let key = format!("{}-{}", umbral_testing::seq(), filename);
        self.files.lock().unwrap().insert(key.clone(), bytes.to_vec());
        Ok(StoredFile { url: format!("/media/{key}"), key, size: bytes.len() as u64 })
    }
    async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError> {
        self.files.lock().unwrap().get(key).cloned().ok_or(StorageError::NotFound)
    }
    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        self.files.lock().unwrap().remove(key);
        self.deleted.lock().unwrap().push(key.to_string());
        Ok(())
    }
    fn url(&self, key: &str) -> String {
        format!("/media/{key}")
    }
}

fn mem() -> &'static Arc<Mem> {
    static M: OnceLock<Arc<Mem>> = OnceLock::new();
    M.get_or_init(|| Arc::new(Mem::default()))
}

async fn app() -> TestApp {
    let app = TestApp::new().await;
    set_storage(mem().clone());
    app
}

fn encoded(w: u32, h: u32, format: ImageFormat) -> Vec<u8> {
    let img = image::DynamicImage::ImageRgba8(RgbaImage::from_fn(w, h, |x, _| image::Rgba([(x % 256) as u8, 40, 90, 255])));
    let img = if format == ImageFormat::Jpeg { image::DynamicImage::ImageRgb8(img.to_rgb8()) } else { img };
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, format).unwrap();
    out.into_inner()
}

/// A JPEG carrying an EXIF block: orientation 6 (rotate 90° clockwise) and a
/// marker string standing in for GPS data.
fn jpeg_with_exif(w: u32, h: u32) -> Vec<u8> {
    let jpeg = encoded(w, h, ImageFormat::Jpeg);
    let mut tiff = b"II*\0\x08\0\0\0".to_vec();
    tiff.extend_from_slice(&1u16.to_le_bytes()); // one IFD entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&6u16.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
    tiff.extend_from_slice(b"GPS-SECRET-PLACE");
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = jpeg[..2].to_vec(); // SOI
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn multipart(field: &str, filename: &str, ctype: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = "XAVATARBOUNDARYX";
    let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn upload(app: &TestApp, user: i64, ctype: &str, body: Vec<u8>) -> support::TestResponse {
    app.raw_as(user, http::Method::POST, AVATAR, HeaderValue::from_str(ctype).unwrap(), body).await
}

async fn upload_file(app: &TestApp, user: i64, filename: &str, bytes: &[u8]) -> support::TestResponse {
    let (ct, body) = multipart("file", filename, "image/png", bytes);
    upload(app, user, &ct, body).await
}

fn key_of(profile: &Value) -> String {
    profile["avatar_url"].as_str().expect("avatar_url").trim_start_matches("/media/").to_string()
}

fn stored(key: &str) -> Vec<u8> {
    mem().files.lock().unwrap().get(key).cloned().expect("stored file")
}

#[tokio::test]
async fn uploads_are_reencoded_as_small_upright_webp() {
    let app = app().await;
    let me = app.create_user().await;
    let p: Value = app.get_as(me.id, PROFILE).await.json();
    assert!(p.as_object().unwrap().contains_key("avatar_url") && p["avatar_url"].is_null(), "{p}");

    // A wide PNG under a hostile name: fit into 512, the key is the server's.
    let r = upload_file(&app, me.id, "../../evil.svg", &encoded(1000, 500, ImageFormat::Png)).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let key = key_of(&r.json());
    assert!(key.ends_with("-avatar.webp") && !key.contains("evil"), "{key}");
    let img = image::load_from_memory(&stored(&key)).unwrap();
    assert_eq!(image::guess_format(&stored(&key)).unwrap(), ImageFormat::WebP);
    assert_eq!((img.width(), img.height()), (512, 256));
    assert_eq!(key_of(&app.get_as(me.id, PROFILE).await.json()), key);

    // EXIF: rotated upright, and nothing of it survives.
    let r = upload_file(&app, me.id, "me.jpg", &jpeg_with_exif(40, 20)).await;
    assert_eq!(r.status(), 200, "{}", r.text());
    let second = key_of(&r.json());
    let bytes = stored(&second);
    let img = image::load_from_memory(&bytes).unwrap();
    assert_eq!((img.width(), img.height()), (20, 40), "orientation 6 turns it upright");
    assert!(!bytes.windows(10).any(|w| w == b"GPS-SECRET"), "metadata is dropped");
    assert!(!bytes.windows(4).any(|w| w == b"Exif"));
    // Replacing deleted the first photo.
    assert!(mem().deleted.lock().unwrap().contains(&key));
    assert!(!mem().files.lock().unwrap().contains_key(&key));

    // GIF and WebP are taken too; a small one isn't scaled up.
    for f in [ImageFormat::Gif, ImageFormat::WebP] {
        let r = upload_file(&app, me.id, "x", &encoded(64, 48, f)).await;
        assert_eq!(r.status(), 200, "{f:?}: {}", r.text());
        let img = image::load_from_memory(&stored(&key_of(&r.json()))).unwrap();
        assert_eq!((img.width(), img.height()), (64, 48));
    }

    // DELETE clears and deletes; again is a no-op.
    let current = key_of(&app.get_as(me.id, PROFILE).await.json());
    let r = app.delete_as(me.id, AVATAR).await;
    assert_eq!(r.status(), 200);
    assert!(r.json()["avatar_url"].is_null());
    assert!(mem().deleted.lock().unwrap().contains(&current));
    assert_eq!(app.delete_as(me.id, AVATAR).await.status(), 200);
    assert!(app.get_as(me.id, PROFILE).await.json()["avatar_url"].is_null());
}

#[tokio::test]
async fn only_real_small_images_are_taken() {
    let app = app().await;
    let me = app.create_user().await;
    let bad = |r: &support::TestResponse, code: u16, err: &str| {
        assert_eq!(r.status(), code, "{}", r.text());
        assert_eq!(r.json()["error"], err, "{}", r.text());
    };

    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    bad(&upload_file(&app, me.id, "a.png", svg).await, 400, "invalid_image");
    bad(&upload_file(&app, me.id, "a.png", b"not an image at all").await, 400, "invalid_image");
    // A truncated PNG: the header sniffs, the pixels don't decode.
    let png = encoded(64, 64, ImageFormat::Png);
    bad(&upload_file(&app, me.id, "a.png", &png[..png.len() / 2]).await, 400, "invalid_image");
    // Too many pixels on a side, though tiny in bytes.
    bad(&upload_file(&app, me.id, "a.png", &encoded(5000, 4, ImageFormat::Png)).await, 400, "invalid_image");
    // Over 1 MiB.
    bad(&upload_file(&app, me.id, "a.png", &vec![7u8; 1024 * 1024 + 1]).await, 413, "too_large");
    // The wrong part name, an empty file, not multipart at all.
    let (ct, body) = multipart("photo", "a.png", "image/png", &png);
    bad(&upload(&app, me.id, &ct, body).await, 400, "no_file");
    bad(&upload_file(&app, me.id, "a.png", b"").await, 400, "no_file");
    bad(&upload(&app, me.id, "application/json", b"{}".to_vec()).await, 415, "not_multipart");

    // Nothing was stored by any of it.
    assert!(app.get_as(me.id, PROFILE).await.json()["avatar_url"].is_null());
}

#[test]
fn normalize_refuses_formats_outside_the_list() {
    // A TIFF header sniffs as TIFF: not on the list, refused before decoding.
    let tiff = b"II*\0\x08\0\0\0\0\0\0\0";
    assert_eq!(image::guess_format(tiff).unwrap(), ImageFormat::Tiff);
    assert!(taskflow_projects::avatar::normalize(tiff).is_err());
    assert!(taskflow_projects::avatar::normalize(&encoded(8, 8, ImageFormat::Png)).is_ok());
}
