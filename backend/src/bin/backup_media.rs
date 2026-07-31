//! Full media backup through the umbral `Storage` trait.
//!
//!   cargo run --bin backup_media                 # -> filesystem target
//!   BACKUP_DIR=/mnt/backups/media cargo run --bin backup_media
//!   UMBRAL_S3_BUCKET=taskflow-media \
//!   UMBRAL_S3_ENDPOINT=http://127.0.0.1:19000 \
//!   UMBRAL_S3_REGION=us-east-1 \
//!   UMBRAL_S3_ACCESS_KEY=... UMBRAL_S3_SECRET_KEY=... \
//!     cargo run --bin backup_media               # -> S3/MinIO/R2 target
//!
//! Walks `./media` (override with `MEDIA_ROOT`) and writes every file to the
//! target at its EXACT key via `Storage::put` — a backup must preserve keys,
//! or the attachment rows' `FileField`s point at nothing on restore. Verifies
//! each object with `Storage::exists` after writing.
//!
//! Target selection: `UMBRAL_S3_BUCKET` set -> `S3Storage::from_env()`
//! (umbral's S3 backend — the machinery this doubles as a live test of);
//! otherwise a filesystem `FsStorage` rooted at `BACKUP_DIR`
//! (default `./media_backup`).
//!
//! This is deliberately an app-level tool built ONLY on the public Storage
//! API (per dalmas: "if it were s3, I would have copied the files over") —
//! anything it can't do through that API is a framework gap to fix in umbra.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use umbral::storage::Storage;
use umbral_storage::FsStorage;

/// Minimal extension→MIME map for the types TaskFlow actually stores. The
/// backup's correctness doesn't depend on it (keys and bytes do), but S3
/// objects carry Content-Type, so an eventual restore-and-serve keeps
/// sensible types.
fn content_type_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "md" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "toml" => "text/plain",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

/// Every file under `root`, as `(absolute path, key relative to root)`.
/// Keys use `/` separators — storage keys are URL path segments, not OS paths.
fn walk(root: &Path) -> std::io::Result<Vec<(PathBuf, String)>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let key = path
                    .strip_prefix(root)
                    .expect("walk stays under root")
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((path, key));
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tokio::main]
async fn main() {
    let media_root = std::env::var("MEDIA_ROOT").unwrap_or_else(|_| "./media".to_string());
    let media_root = PathBuf::from(media_root);
    if !media_root.is_dir() {
        eprintln!("FATAL: media root {} is not a directory", media_root.display());
        std::process::exit(2);
    }

    // Pick the target backend. Both implement `put` (exact key) + `exists`.
    let (target, target_desc): (Arc<dyn Storage>, String) =
        if std::env::var("UMBRAL_S3_BUCKET").is_ok() {
            match umbral_storage::S3Storage::from_env() {
                Ok(s3) => {
                    let desc = format!(
                        "s3 bucket {} ({})",
                        std::env::var("UMBRAL_S3_BUCKET").unwrap_or_default(),
                        std::env::var("UMBRAL_S3_ENDPOINT")
                            .unwrap_or_else(|_| "aws default endpoint".to_string()),
                    );
                    (Arc::new(s3), desc)
                }
                Err(e) => {
                    eprintln!("FATAL: UMBRAL_S3_BUCKET is set but S3Storage::from_env failed: {e}");
                    std::process::exit(2);
                }
            }
        } else {
            let dir = std::env::var("BACKUP_DIR").unwrap_or_else(|_| "./media_backup".to_string());
            std::fs::create_dir_all(&dir).expect("create BACKUP_DIR");
            (
                Arc::new(FsStorage::new("/media", &dir)),
                format!("filesystem {dir}"),
            )
        };

    let files = walk(&media_root).expect("walk media root");
    println!(
        "backup: {} file(s) from {} -> {target_desc}",
        files.len(),
        media_root.display()
    );

    let (mut ok, mut failed) = (0usize, 0usize);
    let mut total_bytes = 0u64;
    for (path, key) in &files {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("READ FAIL  {key}: {e}");
                failed += 1;
                continue;
            }
        };
        match target.put(key, content_type_of(path), &bytes).await {
            Ok(stored) => {
                // A backup that silently mangles keys is worse than one that
                // fails: the restore would 404 every attachment.
                if stored.key != *key {
                    eprintln!("KEY DRIFT  put({key}) stored as {} — refusing to count as ok", stored.key);
                    failed += 1;
                    continue;
                }
                match target.exists(key).await {
                    Ok(true) => {
                        ok += 1;
                        total_bytes += bytes.len() as u64;
                    }
                    Ok(false) => {
                        eprintln!("VERIFY FAIL  {key}: put ok but exists() = false");
                        failed += 1;
                    }
                    Err(e) => {
                        eprintln!("VERIFY ERR  {key}: {e}");
                        failed += 1;
                    }
                }
            }
            Err(e) => {
                eprintln!("PUT FAIL  {key}: {e}");
                failed += 1;
            }
        }
    }

    println!(
        "backup done: {ok} ok, {failed} failed, {:.1} MiB",
        total_bytes as f64 / (1024.0 * 1024.0)
    );
    if failed > 0 {
        std::process::exit(1);
    }
}
