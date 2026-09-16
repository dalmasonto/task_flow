//! The design file store — every accepted write lands here.
//!
//! Concurrency (§6.4): multiple agents touch the same project, so all writes
//! serialize through one async mutex per project. On top of that, a caller may
//! pass `base_version`; a stale base is rejected with 409 + the current row so
//! the loser re-reads and retries instead of silently clobbering a sibling
//! agent's work.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;

use umbral::orm::ForeignKey;

use crate::models::{DesignFile, DesignFileKind, design_file};
use crate::validation;

/// The outcome of an attempted write.
#[derive(Debug)]
pub enum WriteOutcome {
    /// Fresh insert or in-place update; carries the saved row plus any
    /// non-fatal warnings the validator raised (oversized component, …).
    Saved(Box<DesignFile>, validation::Validation),
    /// Stale `base_version`. Carries the CURRENT row so the caller can diff,
    /// merge or retry against reality.
    Conflict(Box<DesignFile>),
    /// Validation failed; carries the structured errors/warnings.
    Rejected(validation::Validation),
}

/// Per-project write locks. The registry itself is behind a std Mutex because
/// it is only ever touched for insert/lookup — sub-microsecond — and must not
/// be held across `.await`.
#[derive(Default, Clone)]
pub struct ProjectLocks {
    inner: Arc<StdMutex<HashMap<i64, Arc<AsyncMutex<()>>>>>,
}

impl ProjectLocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_for(&self, project_id: i64) -> Arc<AsyncMutex<()>> {
        self.inner
            .lock()
            .expect("project lock registry poisoned")
            .entry(project_id)
            .or_default()
            .clone()
    }

    /// Run `f` while holding this project's write lock.
    pub async fn with_lock<F, Fut, T>(&self, project_id: i64, f: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = T>,
    {
        let lock = self.lock_for(project_id);
        let guard = lock.lock().await;
        let out = f().await;
        drop(guard);
        out
    }
}

async fn current_components(project_id: i64) -> Vec<String> {
    DesignFile::objects()
        .filter(
            design_file::PROJECT.eq(project_id)
                & design_file::KIND.eq("component"),
        )
        .fetch()
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|f| {
            f.path
                .strip_prefix("components/")
                .and_then(|p| p.strip_suffix(".js"))
                .map(str::to_string)
        })
        .collect()
}

async fn count_files(project_id: i64) -> usize {
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id))
        .count()
        .await
        .unwrap_or(0) as usize
}

async fn total_bytes(project_id: i64) -> usize {
    // Content lengths summed in-process: the table is capped at 200 rows, so
    // this stays cheap and works identically on SQLite and Postgres.
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id))
        .fetch()
        .await
        .map(|rows| rows.iter().map(|r| r.content.len()).sum())
        .unwrap_or(0)
}

/// Validate + write one file. Runs INSIDE the project lock (callers use
/// [`ProjectLocks::with_lock`]) so the read-check-write sequence cannot
/// interleave with another writer's.
///
/// `updated_by` is server-derived from the caller (`operator` or the agent's
/// display name); it is never read from a request body.
pub async fn write_file(
    project_id: i64,
    path: &str,
    content: &str,
    base_version: Option<i64>,
    updated_by: &str,
) -> WriteOutcome {
    let components = current_components(project_id).await;
    let verdict = validation::validate_write(path, content, &components);
    if !verdict.ok {
        return WriteOutcome::Rejected(verdict);
    }
    let kind = DesignFileKind::for_path(path).expect("validated path implies kind");

    let existing = DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .first()
        .await
        .ok()
        .flatten();

    if let Some(row) = existing.as_ref() {
        if let Some(base) = base_version {
            if row.version != base {
                return WriteOutcome::Conflict(Box::new(row.clone()));
            }
        }
    } else {
        // Caps only bite on NEW files: replacing existing content never grows
        // the footprint beyond what the caps already allowed.
        if count_files(project_id).await >= validation::MAX_FILES_PER_PROJECT {
            return WriteOutcome::Rejected(validation::Validation::pass().fail(
                validation::ValidationError {
                    line: 0,
                    rule: "file-count-cap",
                    message: format!(
                        "This project already holds {} design files; the cap is {}.",
                        count_files(project_id).await,
                        validation::MAX_FILES_PER_PROJECT
                    ),
                    found: None,
                    suggest: None,
                },
            ));
        }
        if total_bytes(project_id).await + content.len() > validation::MAX_PROJECT_BYTES {
            return WriteOutcome::Rejected(validation::Validation::pass().fail(
                validation::ValidationError {
                    line: 0,
                    rule: "project-size-cap",
                    message: "Writing this file would exceed the 4 MB per-project cap.".into(),
                    found: None,
                    suggest: None,
                },
            ));
        }
    }

    match existing {
        Some(row) => {
            let flipped = DesignFile::objects()
                .filter(design_file::ID.eq(row.id) & design_file::VERSION.eq(row.version))
                .update_values(
                    json!({
                        "content": content,
                        "kind": serde_json::to_value(kind).unwrap_or(json!("page")),
                        "version": row.version + 1,
                        "updated_by": updated_by,
                        "updated_at": chrono::Utc::now(),
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                )
                .await
                .unwrap_or(0);
            // The conditional update (version = the version we read) closes the
            // gap between read and write inside the lock; zero rows touched
            // means a writer raced us despite it — surface that as a conflict
            // rather than pretending the write landed.
            if flipped == 0 {
                return WriteOutcome::Conflict(Box::new(row));
            }
            let saved = DesignFile::objects()
                .filter(design_file::ID.eq(row.id))
                .first()
                .await
                .ok()
                .flatten();
            match saved {
                Some(saved) => WriteOutcome::Saved(Box::new(saved), verdict),
                None => WriteOutcome::Conflict(Box::new(row)),
            }
        }
        None => {
            let created = DesignFile::objects()
                .create(DesignFile {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    kind,
                    path: path.to_string(),
                    content: content.to_string(),
                    version: 1,
                    updated_by: updated_by.to_string(),
                    created_at: None,
                    updated_at: None,
                })
                .await;
            match created {
                Ok(saved) => WriteOutcome::Saved(Box::new(saved), verdict),
                Err(_) => WriteOutcome::Rejected(validation::Validation::pass().fail(
                    validation::ValidationError {
                        line: 0,
                        rule: "storage",
                        message: "The write could not be stored; try again.".into(),
                        found: None,
                        suggest: None,
                    },
                )),
            }
        }
    }
}

/// Load every file for a project.
pub async fn list_files(project_id: i64) -> Vec<DesignFile> {
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id))
        .fetch()
        .await
        .unwrap_or_default()
}

/// Load one file by exact path.
pub async fn load_file(project_id: i64, path: &str) -> Option<DesignFile> {
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .first()
        .await
        .ok()
        .flatten()
}
