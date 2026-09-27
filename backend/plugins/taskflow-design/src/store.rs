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
    let mut verdict = validation::validate_write(path, content, &components);
    if !verdict.ok {
        return WriteOutcome::Rejected(verdict);
    }
    let kind = DesignFileKind::for_path(path).expect("validated path implies kind");
    if kind == DesignFileKind::Page {
        // A page that carries its own webfont `<link>` is accepted but told
        // where that link belongs — and whether the project already loads it
        // globally, in which case the page's copy is a pure duplicate.
        let resources_row = DesignFile::objects()
            .filter(
                design_file::PROJECT.eq(project_id)
                    & design_file::PATH.eq(crate::resources::RESOURCES_PATH),
            )
            .first()
            .await
            .ok()
            .flatten();
        let enabled = crate::manifest::resources_from(resources_row.as_slice());
        let hrefs: Vec<&str> = enabled
            .iter()
            .filter(|(is_script, _)| !is_script)
            .filter_map(|(_, l)| l.href.as_deref())
            .collect();
        verdict
            .warnings
            .extend(validation::page_resource_link_warnings(content, &hrefs));
    }

    let existing = DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .first()
        .await
        .ok()
        .flatten();

    // #501: a NEW file at a path whose previous file sits in the trash. The
    // trashed row still holds the unique `(project, path)` slot, so the create
    // below would fail; writing a fresh page where a trashed one was is the
    // caller choosing the new content, so the trashed copy is purged for good.
    if existing.is_none() {
        purge_trashed(project_id, path).await;
    }

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
                    deleted_at: None,
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

/// Delete one file by exact path, returning whether a row was removed.
///
/// `(project, path)` is unique, so this removes at most one row. There is no
/// glob and no recursion, deliberately: the caller names the ONE file it means,
/// and a path that matches nothing deletes nothing rather than everything.
///
/// Like [`write_file`], this runs inside the caller's project lock (see
/// [`ProjectLocks::with_lock`]). A delete is the second half of a
/// read-check-delete sequence — "is anything still using this?" — and that
/// check is only worth making if a writer cannot slip a new usage in between.
///
/// The row is deleted, not blanked: `validation::validate_component` requires
/// exactly one `customElements.define` matching the filename, so an empty
/// component file is a REJECTED write, not a retired one.
pub async fn delete_file(project_id: i64, path: &str) -> bool {
    // HARD, not the model's soft default (#501): retiring a component is not
    // trashing it — there is no component trash to restore from, and a soft
    // row would keep holding its `(project, path)` slot.
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .hard_delete()
        .delete()
        .await
        .map(|removed| removed > 0)
        .unwrap_or(false)
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

/// #501: how many trashed files a project keeps. Trashed rows count toward no
/// cap (the caps are about what renders), so without a bound of their own a
/// write-then-trash loop would grow the table forever. Past this, trashing a
/// file purges the oldest trashed one.
pub const MAX_TRASHED_FILES: usize = 50;

/// Hard-delete the trashed row at `path`, if there is one.
async fn purge_trashed(project_id: i64, path: &str) {
    let _ = DesignFile::objects()
        .only_deleted()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .hard_delete()
        .delete()
        .await;
}

/// The project's trashed files, most recently trashed first.
pub async fn list_trashed(project_id: i64) -> Vec<DesignFile> {
    let mut rows = DesignFile::objects()
        .only_deleted()
        .filter(design_file::PROJECT.eq(project_id))
        .fetch()
        .await
        .unwrap_or_default();
    rows.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    rows
}

/// #501: move one live file to the trash, returning its row id — `None` when
/// no live file has that path. Runs inside the caller's project lock, like
/// every other write here. The ORM's soft `delete()` sets `deleted_at`; from
/// then on every default query skips the row.
///
/// Callers send the realtime event themselves: the ORM's delete payload has no
/// `project` to route it by (see `backend/src/realtime.rs`, DESIGN_FILES).
pub async fn trash_file(project_id: i64, path: &str) -> Option<i64> {
    let row = load_file(project_id, path).await?;
    let trashed = DesignFile::objects()
        .filter(design_file::ID.eq(row.id))
        .delete()
        .await
        .unwrap_or(0);
    if trashed == 0 {
        return None;
    }
    // Keep the trash bounded: purge the oldest past the cap.
    let trash = list_trashed(project_id).await;
    for old in trash.iter().skip(MAX_TRASHED_FILES) {
        let _ = DesignFile::objects()
            .only_deleted()
            .filter(design_file::ID.eq(old.id))
            .hard_delete()
            .delete()
            .await;
    }
    Some(row.id)
}

/// Why a restore did not happen.
pub enum RestoreError {
    /// Nothing in the trash has that path.
    NotInTrash,
    /// Restoring would breach a cap that a NEW file would have to meet.
    Rejected(validation::Validation),
}

/// #501: bring a trashed file back, returning its row id. It is checked
/// against the same file-count and size caps a new file meets, since to every
/// reader it is one. No live file can hold its path: a write to a trashed
/// path purges the trashed copy first (`write_file`), so "restore over a newer
/// page" cannot arise.
pub async fn restore_file(project_id: i64, path: &str) -> Result<i64, RestoreError> {
    let row = DesignFile::objects()
        .only_deleted()
        .filter(design_file::PROJECT.eq(project_id) & design_file::PATH.eq(path))
        .first()
        .await
        .ok()
        .flatten()
        .ok_or(RestoreError::NotInTrash)?;
    if count_files(project_id).await >= validation::MAX_FILES_PER_PROJECT {
        return Err(RestoreError::Rejected(validation::Validation::pass().fail(
            validation::ValidationError {
                line: 0,
                rule: "file-count-cap",
                message: format!(
                    "This project already holds {} design files; restoring would exceed the cap.",
                    validation::MAX_FILES_PER_PROJECT
                ),
                found: None,
                suggest: None,
            },
        )));
    }
    if total_bytes(project_id).await + row.content.len() > validation::MAX_PROJECT_BYTES {
        return Err(RestoreError::Rejected(validation::Validation::pass().fail(
            validation::ValidationError {
                line: 0,
                rule: "project-size-cap",
                message: "Restoring this file would exceed the 4 MB per-project cap.".into(),
                found: None,
                suggest: None,
            },
        )));
    }
    let restored = DesignFile::objects()
        .only_deleted()
        .filter(design_file::ID.eq(row.id))
        .update_values(
            json!({ "deleted_at": serde_json::Value::Null, "updated_at": chrono::Utc::now() })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .unwrap_or(0);
    if restored == 0 {
        return Err(RestoreError::NotInTrash);
    }
    Ok(row.id)
}
