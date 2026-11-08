//! #1131: every write to a design comment row goes through here.
//!
//! A handler loads a comment, does other work, then changes a few fields.
//! Saving the loaded row back WHOLE would revert anything another request
//! wrote in between (a resolve vs a dispatch, a reply's `thread_id`): the
//! #1097 / #1123 lost-update class. So:
//!
//! - Only the changed columns are written, with `update_values`.
//! - A status change is a **compare-and-set**: the update is guarded on the
//!   statuses the transition may start from. Zero rows means another request
//!   moved the comment first, so the caller answers 409 instead of
//!   overwriting it.
//! - `update_values` fires only `bulk_post_save` (ids), which realtime
//!   ignores. So the FRESH row is read back and `post_save` is emitted for it
//!   directly: pins re-colour live, and nothing is written a second time.

use serde_json::{Map, Value, json};
use umbral::web::StatusCode;

use crate::models::{CommentStatus, DesignComment, design_comment};

/// The stored string of a status (`snake_case`, as the column holds it).
pub fn status_str(s: CommentStatus) -> &'static str {
    match s {
        CommentStatus::Open => "open",
        CommentStatus::Sent => "sent",
        CommentStatus::Addressed => "addressed",
        CommentStatus::Dismissed => "dismissed",
    }
}

/// Why a write did not land.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteError {
    /// No such comment in this project.
    NotFound,
    /// It exists, but its status is no longer one the write may start from.
    Conflict,
    Internal,
}

impl From<WriteError> for StatusCode {
    fn from(e: WriteError) -> Self {
        match e {
            WriteError::NotFound => StatusCode::NOT_FOUND,
            WriteError::Conflict => StatusCode::CONFLICT,
            WriteError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

async fn fresh(project: i64, id: i64) -> Result<Option<DesignComment>, WriteError> {
    DesignComment::objects()
        .filter(design_comment::PROJECT.eq(project) & design_comment::ID.eq(id))
        .first()
        .await
        .map_err(|_| WriteError::Internal)
}

/// Write `values` to one comment, only while its status is one of `from`
/// (`None`: any status, for a person's edit that changes no status). Returns
/// the fresh row, after emitting `post_save` for it.
pub async fn write(
    project: i64,
    id: i64,
    from: Option<&[CommentStatus]>,
    values: Map<String, Value>,
) -> Result<DesignComment, WriteError> {
    if !values.is_empty() {
        let mut guard = design_comment::PROJECT.eq(project) & design_comment::ID.eq(id);
        if let Some(from) = from {
            let allowed: Vec<&str> = from.iter().map(|s| status_str(*s)).collect();
            guard = guard & design_comment::STATUS.in_(&allowed);
        }
        let n = DesignComment::objects()
            .filter(guard)
            .update_values(values)
            .await
            .map_err(|_| WriteError::Internal)?;
        if n == 0 {
            return Err(match fresh(project, id).await? {
                None => WriteError::NotFound,
                Some(_) => WriteError::Conflict,
            });
        }
    }
    let row = fresh(project, id).await?.ok_or(WriteError::NotFound)?;
    emit_post_save(&row).await;
    Ok(row)
}

/// The `post_save` a whole-row save would have fired, without the write: the
/// same name and `{instance, created}` payload as umbral's own emit (which
/// the `umbral` facade does not re-export; umbra gaps6 #27), so realtime's
/// `expose` picks it up. Kept honest by `tests/comment_cas.rs`.
async fn emit_post_save(row: &DesignComment) {
    use umbral::orm::Model as _;
    let Ok(mut instance) = serde_json::to_value(row) else { return };
    if let Value::Object(map) = &mut instance {
        for field in DesignComment::SIGNAL_SKIP_FIELDS {
            map.remove(*field);
        }
    }
    umbral::signals::emit(&format!("post_save:{}", DesignComment::TABLE), json!({ "instance": instance, "created": false })).await;
}

/// Give back a dispatch's claim: sent → open, only while the comment is still
/// sent to THIS agent (a resolve or a re-dispatch since then is left alone).
/// Emits `post_save` like every write here, so the pin re-colours live.
pub async fn release_claim(project: i64, id: i64, agent: i64) -> Result<(), WriteError> {
    let mut v = Map::new();
    v.insert("status".into(), json!(status_str(CommentStatus::Open)));
    v.insert("sent_to_agent".into(), Value::Null);
    let n = DesignComment::objects()
        .filter(
            design_comment::PROJECT.eq(project)
                & design_comment::ID.eq(id)
                & design_comment::STATUS.eq(status_str(CommentStatus::Sent))
                & design_comment::SENT_TO_AGENT.eq(agent),
        )
        .update_values(v)
        .await
        .map_err(|_| WriteError::Internal)?;
    if n > 0 {
        if let Some(row) = fresh(project, id).await? {
            emit_post_save(&row).await;
        }
    }
    Ok(())
}

/// Set `resolution_note` only where it is still null (the "Addressed."
/// default a person's PATCH adds). A no-op when a note exists.
pub async fn default_note(project: i64, id: i64, note: &str) -> Result<(), WriteError> {
    let mut v = Map::new();
    v.insert("resolution_note".into(), json!(note));
    DesignComment::objects()
        .filter(design_comment::PROJECT.eq(project) & design_comment::ID.eq(id) & design_comment::RESOLUTION_NOTE.is_null())
        .update_values(v)
        .await
        .map(|_| ())
        .map_err(|_| WriteError::Internal)
}
