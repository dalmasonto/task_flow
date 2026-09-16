//! Models for the `taskflow-design` plugin — the Design Surface storage layer.
//!
//! Two tables, per §5 of the design-surface spec:
//!
//! * `design_file`   — every agent- or operator-authored artifact (tokens,
//!   components, page fragments, assets) as a versioned row keyed by
//!   `(project, path)`. There are deliberately NO loose files on disk: rows
//!   version cleanly, travel with backups, and cannot escape the directory the
//!   validator controls.
//! * `design_comment` — an operator comment anchored to an element on one
//!   rendered route, carrying everything an agent needs to find and edit the
//!   right source (file + line ref, component name, element path, blast radius).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use umbral::orm::{Choices, ForeignKey};

use taskflow_projects::models::TaskflowProject;

/// What kind of artifact a `design_file` row holds. Drives which validation
/// rules apply on write (see `validation.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum DesignFileKind {
    Token,
    Component,
    Page,
    Asset,
}

impl DesignFileKind {
    /// The kind implied by a writable path's first segment. `None` for a path
    /// outside the four known directories — which the path validator rejects
    /// before this is ever consulted.
    pub fn for_path(path: &str) -> Option<Self> {
        if let Some(rest) = path.strip_prefix("pages/") {
            let _ = rest;
            Some(Self::Page)
        } else if path.starts_with("components/") {
            Some(Self::Component)
        } else if path.starts_with("styles/") {
            Some(Self::Token)
        } else if path.starts_with("assets/") {
            Some(Self::Asset)
        } else {
            None
        }
    }
}

/// One authored file. `version` is monotonic per `(project, path)`; writes may
/// carry a `base_version` and are rejected with 409 when stale so concurrent
/// agents re-read and retry instead of silently clobbering each other.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["project", "path"]])]
pub struct DesignFile {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    #[umbral(choices, default = "page")]
    pub kind: DesignFileKind,
    /// Repository-style path relative to the project's design root, e.g.
    /// `components/app-header.js`. Validated by `validation::validate_path`.
    #[umbral(string, max_length = 80)]
    pub path: String,
    /// Full file content. Capped at 128 KiB by the write path (the DB column
    /// allows more so admin can still see oversized rejects in context).
    #[umbral(string, max_length = 262_144, widget = "textarea")]
    pub content: String,
    /// Bumped on every accepted write. Server-managed — never read from a body.
    #[umbral(default = "1")]
    pub version: i64,
    /// Agent display name or `operator`. Server-derived from the caller.
    #[umbral(string, max_length = 120)]
    pub updated_by: String,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
    #[umbral(noedit)]
    pub updated_at: Option<DateTime<Utc>>,
}

/// How far a comment's change should reach. `component` edits the shared
/// component file; `instance` expresses the change as attributes on the one
/// usage (the reversible default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum CommentScope {
    Component,
    Instance,
}

/// Lifecycle: open → sent (dispatched to an agent) → addressed | dismissed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Choices, Serialize, Deserialize)]
#[choices(rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum CommentStatus {
    Open,
    Sent,
    Addressed,
    Dismissed,
}

/// An operator annotation anchored to an element on one rendered route.
///
/// The anchor fields (`element_path`, `rect`, `snippet`, `src_ref`) are captured
/// at comment time from the sandbox frame; they let the pin re-anchor after
/// reloads and give the dispatch payload a resolvable target even when the
/// element lives inside a component's template string (where `src_ref` is null
/// and `component` + `element_path` take over).
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
pub struct DesignComment {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub project: ForeignKey<TaskflowProject>,
    /// The route this was captured on, e.g. `/settings`. Named `page_path`
    /// after the spec's field.
    #[umbral(string, max_length = 200)]
    pub page_path: String,
    /// Nearest `[data-component]` host, when the selection resolved to one.
    #[umbral(string, max_length = 120)]
    pub component_name: Option<String>,
    /// CSS-ish path from the component root, e.g.
    /// `app-header > div:nth-child(2) > img`.
    #[umbral(string, max_length = 500)]
    pub element_path: String,
    /// `pages/settings.html:12` when the element came from a page fragment;
    /// null for elements generated inside a component template.
    #[umbral(string, max_length = 200)]
    pub src_ref: Option<String>,
    /// Device preset id at capture time, e.g. `iphone-16-pro`.
    #[umbral(string, max_length = 60)]
    pub viewport: String,
    /// JSON `{x,y,w,h}` at capture time, for re-anchoring the pin.
    #[umbral(string, max_length = 200, widget = "textarea")]
    pub rect: String,
    /// outerHTML truncated to 600 chars by the picker before it left the frame.
    #[umbral(string, max_length = 700, widget = "textarea")]
    pub snippet: String,
    /// The operator's actual instruction. Escaped again at chrome render time.
    #[umbral(string, max_length = 4000, widget = "textarea")]
    pub body: String,
    #[umbral(choices, default = "instance")]
    pub scope: CommentScope,
    #[umbral(choices, default = "open")]
    pub status: CommentStatus,
    /// Groups replies into threads. Null until a threaded reply exists.
    #[umbral(string, max_length = 64)]
    pub thread_id: Option<String>,
    /// Display name of whoever wrote it (`operator`, or an agent name).
    #[umbral(string, max_length = 120)]
    pub author: String,
    /// The agent's note recorded when marking the comment addressed.
    #[umbral(string, max_length = 2000, widget = "textarea")]
    pub resolution_note: Option<String>,
    /// Set when the anchored element no longer resolves after an edit; the pin
    /// stays visible with its text and offers re-anchoring.
    #[umbral(default = "false")]
    pub orphaned: bool,
    #[umbral(noedit, auto_now_add)]
    pub created_at: Option<DateTime<Utc>>,
}
