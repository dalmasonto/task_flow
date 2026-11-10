//! #1135 part 5: the caller's profile photo.
//!
//! | Route | Body | Returns |
//! |---|---|---|
//! | `POST /api/taskflow/me/avatar` | multipart, one file part `file`, ≤ 1 MiB | 200 the profile |
//! | `DELETE /api/taskflow/me/avatar` | | 200 the profile |
//!
//! * **Never stored as sent.** The bytes must sniff as PNG, JPEG, WebP or GIF
//!   (the client's name and type are ignored; SVG never decodes). Decoding is
//!   capped by [`Limits`] (4096 × 4096, 64 MiB) before anything is allocated,
//!   then the image is turned upright (EXIF orientation), fit inside 512 px,
//!   and re-encoded as lossless WebP. Re-encoding drops every metadata block,
//!   GPS included. A GIF keeps its first frame.
//! * The storage key is the server's (`<uuid>-avatar.webp`), never the
//!   client filename. Replacing or removing deletes the old file (best
//!   effort: a failed delete leaves an orphan, never a broken profile).
//! * Errors: 415 not multipart, 400 `no_file`, 413 `too_large`,
//!   400 `invalid_image`, 503 `storage_unavailable`.
//! * Read access is in `backend/src/media_access.rs`: any signed-in caller may
//!   read a key that is some user's current avatar (it's shown wherever that
//!   person appears; the key is a random uuid).

use std::io::Cursor;

use chrono::Utc;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde_json::{Value, json};
use umbral::prelude::IntoResponse;
use umbral::web::multipart::{MultipartError, is_multipart, parse_multipart_capped};
use umbral::web::{Json, Response, StatusCode};
use umbral_auth::RequireAuth;

use crate::models::{TaskflowUserSettings, taskflow_user_settings};

/// The largest upload accepted, in bytes.
pub const MAX_BYTES: usize = 1024 * 1024;
/// Room for the multipart framing around a `MAX_BYTES` file.
const FRAMING: usize = 16 * 1024;
pub const MAX_INPUT_SIDE: u32 = 4096;
const MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;
/// The stored image fits inside this square.
pub const SIDE: u32 = 512;
pub const STORED_NAME: &str = "avatar.webp";

type ApiError = (StatusCode, Json<Value>);

fn err(status: StatusCode, code: &str, detail: &str) -> ApiError {
    (status, Json(json!({ "error": code, "detail": detail })))
}

fn internal<E: std::fmt::Display>(e: E) -> ApiError {
    tracing::error!(error = %e, "avatar failed");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal", "internal error")
}

fn invalid_image() -> ApiError {
    err(StatusCode::BAD_REQUEST, "invalid_image", "Upload a PNG, JPEG, WebP or GIF image, at most 4096 px on a side.")
}

/// Decode `bytes` under the limits and re-encode them as the stored WebP.
/// CPU-bound: call it off the async runtime.
pub fn normalize(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let format = image::guess_format(bytes).map_err(|_| "unknown format")?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) {
        return Err("unsupported format");
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_SIDE);
    limits.max_image_height = Some(MAX_INPUT_SIDE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| "undecodable")?;
    // A malformed EXIF block only loses the rotation, never the photo.
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|_| "undecodable")?;
    img.apply_orientation(orientation);
    if img.width() > SIDE || img.height() > SIDE {
        img = img.thumbnail(SIDE, SIDE);
    }
    let rgba = img.to_rgba8();
    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .encode(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
        .map_err(|_| "encode failed")?;
    Ok(out)
}

async fn current_key(user: i64) -> Result<Option<String>, ApiError> {
    Ok(TaskflowUserSettings::objects()
        .filter(taskflow_user_settings::USER.eq(user))
        .first()
        .await
        .map_err(internal)?
        .and_then(|s| s.avatar)
        .filter(|k| !k.is_empty()))
}

async fn set_key(user: i64, key: Option<&str>) -> Result<(), ApiError> {
    crate::views::ensure_user_settings(user).await.map_err(|s| (s, Json(json!({ "error": "internal" }))))?;
    let mut v = serde_json::Map::new();
    v.insert("avatar".into(), key.map_or(Value::Null, |k| json!(k)));
    v.insert("updated_at".into(), json!(Utc::now()));
    TaskflowUserSettings::objects()
        .filter(taskflow_user_settings::USER.eq(user))
        .update_values(v)
        .await
        .map_err(internal)?;
    Ok(())
}

async fn delete_blob(key: &str) {
    if let Some(storage) = umbral::storage::storage_opt() {
        if let Err(e) = storage.delete(key).await {
            tracing::warn!(error = %e, "old avatar not deleted; it is orphaned");
        }
    }
}

/// `avatar_url` for `GET me/profile`: `None` when the user has none.
pub fn url_for(key: Option<&str>) -> Option<String> {
    key.filter(|k| !k.is_empty()).map(|k| umbral::orm::FileField::from(k).url())
}

/// `POST /api/taskflow/me/avatar`
pub async fn upload(RequireAuth(user): RequireAuth<i64>, headers: umbral::web::HeaderMap, body: axum::body::Bytes) -> Result<Response, ApiError> {
    let content_type = headers.get(umbral::web::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    if !is_multipart(&content_type) {
        return Err(err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_multipart", "Send the image as multipart/form-data, in a part named `file`."));
    }
    let too_large = || err(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "The image is over 1 MB.");
    let form = parse_multipart_capped(&content_type, body, MAX_BYTES + FRAMING).await.map_err(|e| match e {
        MultipartError::TooLarge { .. } => too_large(),
        _ => err(StatusCode::BAD_REQUEST, "invalid", "The upload could not be read."),
    })?;
    let Some(part) = form.files.into_iter().find(|p| p.field_name == "file") else {
        return Err(err(StatusCode::BAD_REQUEST, "no_file", "Attach the image in a part named `file`."));
    };
    if part.bytes.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "no_file", "The file is empty."));
    }
    if part.bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    let webp = tokio::task::spawn_blocking(move || normalize(&part.bytes)).await.map_err(internal)?.map_err(|_| invalid_image())?;
    let Some(storage) = umbral::storage::storage_opt() else {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable", "File storage isn't set up on this server."));
    };
    let old = current_key(user).await?;
    let stored = storage.store(STORED_NAME, "image/webp", &webp).await.map_err(internal)?;
    if let Err(e) = set_key(user, Some(&stored.key)).await {
        delete_blob(&stored.key).await;
        return Err(e);
    }
    if let Some(old) = old.filter(|o| *o != stored.key) {
        delete_blob(&old).await;
    }
    Ok(Json(crate::account::profile_json(user).await?).into_response())
}

/// `DELETE /api/taskflow/me/avatar`
pub async fn remove(RequireAuth(user): RequireAuth<i64>) -> Result<Response, ApiError> {
    if let Some(old) = current_key(user).await? {
        set_key(user, None).await?;
        delete_blob(&old).await;
    }
    Ok(Json(crate::account::profile_json(user).await?).into_response())
}
