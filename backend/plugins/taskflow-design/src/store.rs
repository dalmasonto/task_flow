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

use crate::models::{DesignFile, DesignFileKind, DesignFileVersion, design_file, design_file_version};
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
    // Content lengths summed in-process: there is no `SUM(LENGTH(content))`
    // through the ORM's aggregates (they sum a COLUMN, not an expression), and
    // hand-rolled per-backend SQL would fork the soft-delete and read-routing
    // seams this query relies on. The cost is bounded and paid off the hot
    // path — only a write that ADDS a file checks the caps (see `write_file`),
    // plus a restore, so an edit never runs this. At #665's 500-file cap that
    // is at most one project's worth of content (~16 MiB) per added file.
    // `.values(&["content"])` fetches the one column being summed, so the cost
    // is the text itself, not also decoding 500 full model rows.
    DesignFile::objects()
        .filter(design_file::PROJECT.eq(project_id))
        .values(&["content"])
        .await
        .map(|rows| {
            rows.iter()
                .map(|row| row["content"].as_str().map(str::len).unwrap_or(0))
                .sum()
        })
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
                    message: "Writing this file would exceed the 16 MB per-project cap.".into(),
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
                Some(saved) => {
                    // #520: the write is recorded before anything is pruned.
                    record_and_prune(project_id, &saved, false).await;
                    WriteOutcome::Saved(Box::new(saved), verdict)
                }
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
                Ok(saved) => {
                    record_and_prune(project_id, &saved, false).await;
                    WriteOutcome::Saved(Box::new(saved), verdict)
                }
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

// ---------------------------------------------------------------------------
// #520: history — one row per accepted write, and the point-in-time reads
// ---------------------------------------------------------------------------

/// #520: the outcome of bringing an old version back.
pub enum RestoreVersionOutcome {
    /// The version's content was written as a NEW file version.
    Restored(Box<DesignFile>),
    /// No recorded row has that `(path, version)` — aged out, or never existed.
    UnknownVersion,
    /// The write was refused by the shared validator (a version that predates
    /// a rule change can be invalid today; the content is checked like any
    /// write, deliberately).
    Rejected(validation::Validation),
    /// A writer raced us between our read and our write.
    Conflict(Box<DesignFile>),
}

/// #520: restore an old version AS A NEW WRITE. History stays append-only —
/// undoing a restore is just another restore — and the content goes through
/// the same validator and versioning as any write. Runs inside the caller's
/// project lock; `base_version` is taken from the CURRENT row (read in here),
/// which is a race guard, not a refusal: choosing an old version IS the ask.
pub async fn restore_version(
    project_id: i64,
    path: &str,
    version: i64,
    updated_by: &str,
) -> RestoreVersionOutcome {
    let Some(old) = read_version(project_id, path, version).await else {
        return RestoreVersionOutcome::UnknownVersion;
    };
    let base = load_file(project_id, path).await.map(|row| row.version);
    match write_file(project_id, path, &old.content, base, updated_by).await {
        WriteOutcome::Saved(row, _) => RestoreVersionOutcome::Restored(row),
        WriteOutcome::Rejected(verdict) => RestoreVersionOutcome::Rejected(verdict),
        WriteOutcome::Conflict(row) => RestoreVersionOutcome::Conflict(row),
    }
}

/// How many versions of one path are kept. The owner's call ("keep like the
/// last versions of the design screen"), 20 to start; a setting later if it
/// ever matters.
pub const KEEP_VERSIONS_PER_PATH: usize = 20;

/// The whole project's history may not outgrow this — a backstop under the
/// per-path count, for a project of many very large files.
pub const HISTORY_MAX_BYTES: i64 = 160 * 1024 * 1024;

/// The style documents a page renders THROUGH. Their history is pruned by the
/// retained pages' revisions, not by their own count: see `prune_history`.
const STYLE_PATHS: [&str; 3] = ["styles/tokens.json", "styles/tokens.css", crate::resources::RESOURCES_PATH];

/// The next project revision. Called INSIDE the project lock (every caller of
/// the recording functions is), so the read-then-write cannot race another
/// writer.
async fn next_revision(project_id: i64) -> i64 {
    DesignFileVersion::objects()
        .filter(design_file_version::PROJECT.eq(project_id))
        .order_by(design_file_version::PROJECT_REVISION.desc())
        .first()
        .await
        .ok()
        .flatten()
        .map(|row| row.project_revision + 1)
        .unwrap_or(1)
}

/// Record one accepted write (or trash). Best-effort on purpose: the FILE is
/// saved by the time this runs, and a history row that cannot be written must
/// not turn a successful save into an error — the cost of the failure is a
/// missing point in the timeline, and it is said out loud rather than hidden.
#[allow(clippy::too_many_arguments)]
async fn record_version(
    project_id: i64,
    revision: i64,
    path: &str,
    kind: DesignFileKind,
    content: &str,
    version: i64,
    deleted: bool,
    updated_by: &str,
) {
    let row = DesignFileVersion {
        id: 0,
        project: ForeignKey::new(project_id),
        kind,
        path: path.to_string(),
        content: content.to_string(),
        version,
        project_revision: revision,
        bytes: content.len() as i64,
        deleted,
        updated_by: updated_by.to_string(),
        created_at: None,
    };
    if DesignFileVersion::objects().create(row).await.is_err() {
        eprintln!("design history: could not record {path} at revision {revision}");
    }
}

/// Record a write AND prune, in the one order that is safe: the new row is in
/// before anything is deleted.
async fn record_and_prune(project_id: i64, row: &DesignFile, deleted: bool) {
    let revision = next_revision(project_id).await;
    record_version(project_id, revision, &row.path, row.kind, &row.content, row.version, deleted, &row.updated_by).await;
    prune_history(project_id, &row.path).await;
}

/// One version of a path, without its content — what a version LIST shows.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VersionSummary {
    pub version: i64,
    pub project_revision: i64,
    pub bytes: i64,
    pub deleted: bool,
    pub updated_by: String,
    /// When the write landed — what a version list is read for.
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Every recorded version of one path, newest first.
pub async fn list_versions(project_id: i64, path: &str) -> Vec<VersionSummary> {
    let mut rows = DesignFileVersion::objects()
        .filter(design_file_version::PROJECT.eq(project_id) & design_file_version::PATH.eq(path))
        .fetch()
        .await
        .unwrap_or_default();
    rows.sort_by(|a, b| b.project_revision.cmp(&a.project_revision));
    rows.into_iter()
        .map(|row| VersionSummary {
            version: row.version,
            project_revision: row.project_revision,
            bytes: row.bytes,
            deleted: row.deleted,
            updated_by: row.updated_by,
            created_at: row.created_at,
        })
        .collect()
}

/// One recorded version's content — the NEWEST row for that `(path, version)`,
/// because a version number repeats when a restore re-records it.
pub async fn read_version(project_id: i64, path: &str, version: i64) -> Option<DesignFileVersion> {
    let mut rows = DesignFileVersion::objects()
        .filter(
            design_file_version::PROJECT.eq(project_id)
                & design_file_version::PATH.eq(path)
                & design_file_version::VERSION.eq(version),
        )
        .fetch()
        .await
        .ok()?;
    rows.sort_by(|a, b| b.project_revision.cmp(&a.project_revision));
    rows.into_iter().next()
}

/// #520: the project's files as of `revision`, shaped exactly like the live
/// rows — so the composer, the manifest and the subresource URLs can be
/// pointed at a past moment without knowing it is one.
pub async fn files_at(project_id: i64, revision: i64) -> Vec<DesignFile> {
    project_state_at(project_id, revision)
        .await
        .into_iter()
        .map(|row| DesignFile {
            id: row.id,
            project: row.project,
            kind: row.kind,
            path: row.path,
            content: row.content,
            version: row.version,
            updated_by: row.updated_by,
            created_at: row.created_at,
            updated_at: None,
            deleted_at: None,
        })
        .collect()
}

/// The whole project's state at `revision`: for each path, the newest row at
/// or before it, with tombstones (trashed paths) dropped.
pub async fn project_state_at(project_id: i64, revision: i64) -> Vec<DesignFileVersion> {
    let mut rows = DesignFileVersion::objects()
        .filter(
            design_file_version::PROJECT.eq(project_id)
                & design_file_version::PROJECT_REVISION.lte(revision),
        )
        .fetch()
        .await
        .unwrap_or_default();
    // Newest first, then first-seen per path wins.
    rows.sort_by(|a, b| b.project_revision.cmp(&a.project_revision));
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter(|row| seen.insert(row.path.clone()))
        .filter(|row| !row.deleted)
        .collect()
}

/// #520's retention, run in the write path (cheap, per project — no cron):
///
/// 1. The path just written keeps its newest [`KEEP_VERSIONS_PER_PATH`] rows.
/// 2. The STYLE documents are pruned against the OLDEST RETAINED PAGE version
///    instead: a retained page must still render with the tokens of its time,
///    so the version in effect at that revision is kept even if it is older
///    than 20 of its own writes. (This is the rule the task names, and it is
///    the reason a style path cannot simply be counted like a page.)
/// 3. A byte backstop for a project of many large files.
pub async fn prune_history(project_id: i64, written_path: &str) {
    let kind = DesignFileKind::for_path(written_path);
    match kind {
        // A page is counted: 20 of it, newest first. Style and component
        // versions are NOT counted — they are the render inputs of retained
        // page versions, and the rule below protects exactly those.
        Some(DesignFileKind::Page) => prune_path_to_count(project_id, written_path).await,
        Some(_) => {
            if let Some(min_rev) = oldest_retained_page_revision(project_id).await {
                prune_style_path(project_id, written_path, min_rev).await;
            }
        }
        None => {}
    }
    // A page write can AGE A PAGE OUT, which moves the horizon: the style
    // paths protected only by that page's revision may now prune. (Components
    // are too many to sweep on every page write; theirs is re-checked when
    // they are next written, and bounded by the byte cap either way.)
    if matches!(kind, Some(DesignFileKind::Page)) {
        if let Some(min_rev) = oldest_retained_page_revision(project_id).await {
            for path in STYLE_PATHS {
                prune_style_path(project_id, path, min_rev).await;
            }
        }
    }
    enforce_byte_cap(project_id).await;
}

/// One path's rows as `(id, project_revision, bytes)`, newest first — read
/// through `values` so a prune never loads content.
async fn rows_of(project_id: i64, path: &str) -> Vec<(i64, i64, i64)> {
    let values = DesignFileVersion::objects()
        .filter(design_file_version::PROJECT.eq(project_id) & design_file_version::PATH.eq(path))
        .values(&["id", "project_revision", "bytes"])
        .await
        .unwrap_or_default();
    let mut rows: Vec<(i64, i64, i64)> = values
        .iter()
        .filter_map(|row| {
            Some((
                row["id"].as_i64()?,
                row["project_revision"].as_i64()?,
                row["bytes"].as_i64().unwrap_or(0),
            ))
        })
        .collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    rows
}

async fn prune_path_to_count(project_id: i64, path: &str) {
    let rows = rows_of(project_id, path).await;
    for (id, _, _) in rows.iter().skip(KEEP_VERSIONS_PER_PATH) {
        let _ = DesignFileVersion::objects()
            .filter(design_file_version::ID.eq(*id))
            .delete()
            .await;
    }
}

/// The revision of the oldest KEPT page version — the horizon below which no
/// retained page can reach. `None` while a project has fewer than
/// `KEEP_VERSIONS_PER_PATH` page rows: nothing has aged out, so nothing is
/// prunable under this rule.
async fn oldest_retained_page_revision(project_id: i64) -> Option<i64> {
    let values = DesignFileVersion::objects()
        .filter(
            design_file_version::PROJECT.eq(project_id)
                & design_file_version::KIND.eq("page"),
        )
        .values(&["project_revision"])
        .await
        .unwrap_or_default();
    let mut revisions: Vec<i64> = values.iter().filter_map(|row| row["project_revision"].as_i64()).collect();
    if revisions.len() < KEEP_VERSIONS_PER_PATH {
        return None;
    }
    revisions.sort_unstable();
    // The KEEP-newest window's oldest member.
    Some(revisions[revisions.len() - KEEP_VERSIONS_PER_PATH])
}

/// Keep the newest style row at or before `min_rev` (the version a retained
/// page renders with) and everything newer; drop what it superseded.
async fn prune_style_path(project_id: i64, path: &str, min_rev: i64) {
    let rows = rows_of(project_id, path).await; // newest first
    let keep_from = rows.iter().find(|(_, revision, _)| *revision <= min_rev).map(|(_, revision, _)| *revision);
    let Some(keep_from) = keep_from else {
        return; // every row is older than the horizon's page: nothing in effect
    };
    for (id, revision, _) in &rows {
        if *revision < keep_from {
            let _ = DesignFileVersion::objects()
                .filter(design_file_version::ID.eq(*id))
                .delete()
                .await;
        }
    }
}

async fn enforce_byte_cap(project_id: i64) {
    let values = DesignFileVersion::objects()
        .filter(design_file_version::PROJECT.eq(project_id))
        .values(&["id", "project_revision", "bytes"])
        .await
        .unwrap_or_default();
    let mut rows: Vec<(i64, i64, i64)> = values
        .iter()
        .filter_map(|row| {
            Some((
                row["id"].as_i64()?,
                row["project_revision"].as_i64()?,
                row["bytes"].as_i64().unwrap_or(0),
            ))
        })
        .collect();
    let mut total: i64 = rows.iter().map(|(_, _, bytes)| *bytes).sum();
    if total <= HISTORY_MAX_BYTES {
        return;
    }
    rows.sort_by(|a, b| a.1.cmp(&b.1)); // oldest first
    for (id, _, bytes) in rows {
        if total <= HISTORY_MAX_BYTES {
            break;
        }
        let _ = DesignFileVersion::objects()
            .filter(design_file_version::ID.eq(id))
            .delete()
            .await;
        total -= bytes;
    }
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

/// #501: move one live file to the trash, returning `(row id, version)` —
/// `None` when no live file has that path. Runs inside the caller's project
/// lock, like every other write here. The ORM's soft `delete()` sets
/// `deleted_at`; from then on every default query skips the row.
///
/// The version rides along because the caller announces the trash on realtime
/// (`views::trash_page_by_route` → `signals::emit_file_event`), and the row it
/// would otherwise re-read is hidden from every default query by then.
///
/// Callers send the realtime event themselves: the ORM's delete payload has no
/// `project` to route it by (see `backend/src/realtime.rs`, DESIGN_FILES).
pub async fn trash_file(project_id: i64, path: &str) -> Option<(i64, i64)> {
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
    // #520: a trash is part of the history — a tombstone at this revision
    // means the path did not exist from here until a restore says otherwise.
    record_and_prune(project_id, &row, true).await;
    Some((row.id, row.version))
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
                message: "Restoring this file would exceed the 16 MB per-project cap.".into(),
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
    record_and_prune(project_id, &row, false).await;
    Ok(row.id)
}
