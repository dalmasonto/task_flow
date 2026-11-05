//! Versioned saves for the schema document (#885). Every write — human or
//! agent — goes through [`save`]: under the project's lock it checks
//! `base_version`, applies the change, validates the result, bumps the version
//! and appends a history row. A stale writer is told, never silently clobbered.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};

use serde::Serialize;
use serde_json::json;
use tokio::sync::Mutex as AsyncMutex;
use umbral::orm::ForeignKey;

use crate::models::{DbSchema, DbSchemaVersion, db_schema, db_schema_version};
use crate::schema_doc::{LockConflict, SchemaDoc, validate};

fn lock_for(project_id: i64) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<StdMutex<HashMap<i64, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    LOCKS
        .get_or_init(Default::default)
        .lock()
        .expect("db lock registry poisoned")
        .entry(project_id)
        .or_default()
        .clone()
}

#[derive(Debug, Clone, Serialize)]
pub struct Current {
    pub version: i64,
    pub doc: SchemaDoc,
    pub updated_by: String,
    pub updated_by_label: String,
    pub updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug)]
pub enum SaveError {
    /// `base_version` is behind: someone saved in between.
    Stale { current: i64 },
    /// The resulting document breaks a rule; each entry names where.
    Invalid(Vec<String>),
    /// An agent tried to change locked fields without `override`.
    Locked(LockConflict),
    /// The change refers to something that is not there (e.g. a model).
    NotFound(String),
    Db(String),
}

/// The project's current schema; version 0 and an empty document when none
/// has been written yet (agents write the first model; nothing is seeded).
pub async fn load(project_id: i64) -> Result<Current, SaveError> {
    let row = DbSchema::objects()
        .filter(db_schema::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|e| SaveError::Db(e.to_string()))?;
    Ok(match row {
        Some(r) => Current {
            version: r.version,
            doc: serde_json::from_str(&r.doc_json).unwrap_or_default(),
            updated_by: r.updated_by,
            updated_by_label: r.updated_by_label,
            updated_at: r.updated_at.or(r.created_at),
        },
        None => Current {
            version: 0,
            doc: SchemaDoc::default(),
            updated_by: String::new(),
            updated_by_label: String::new(),
            updated_at: None,
        },
    })
}

/// Apply `change` to the current document and store the result as the next
/// version. `base_version` of `None` means "whatever is current" (only the
/// restore path uses it); everyone else must say which version they read.
pub async fn save<F>(
    project_id: i64,
    base_version: Option<i64>,
    author: &str,
    author_label: &str,
    change: F,
) -> Result<Current, SaveError>
where
    F: FnOnce(&SchemaDoc) -> Result<(SchemaDoc, String), SaveError>,
{
    let lock = lock_for(project_id);
    let _guard = lock.lock().await;

    let current = load(project_id).await?;
    if let Some(base) = base_version {
        if base != current.version {
            return Err(SaveError::Stale { current: current.version });
        }
    }
    let (next, note) = change(&current.doc)?;
    let errors = validate(&next);
    if !errors.is_empty() {
        return Err(SaveError::Invalid(errors));
    }
    let doc_json = serde_json::to_string(&next).map_err(|e| SaveError::Db(e.to_string()))?;
    let version = current.version + 1;
    let now = chrono::Utc::now();

    let existing = DbSchema::objects()
        .filter(db_schema::PROJECT.eq(project_id))
        .first()
        .await
        .map_err(|e| SaveError::Db(e.to_string()))?;
    match existing {
        Some(row) => {
            DbSchema::objects()
                .filter(db_schema::ID.eq(row.id))
                .update_values(
                    json!({
                        "doc_json": doc_json,
                        "version": version,
                        "updated_by": author,
                        "updated_by_label": author_label,
                        "updated_at": now,
                    })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
                )
                .await
                .map_err(|e| SaveError::Db(e.to_string()))?;
        }
        None => {
            DbSchema::objects()
                .create(DbSchema {
                    id: 0,
                    project: ForeignKey::new(project_id),
                    doc_json: doc_json.clone(),
                    version,
                    updated_by: author.to_string(),
                    updated_by_label: author_label.to_string(),
                    created_at: None,
                    updated_at: Some(now),
                })
                .await
                .map_err(|e| SaveError::Db(e.to_string()))?;
        }
    }
    DbSchemaVersion::objects()
        .create(DbSchemaVersion {
            id: 0,
            project: ForeignKey::new(project_id),
            version,
            doc_json,
            author: author.to_string(),
            author_label: author_label.to_string(),
            note: note.chars().take(300).collect(),
            created_at: None,
        })
        .await
        .map_err(|e| SaveError::Db(e.to_string()))?;

    Ok(Current {
        version,
        doc: next,
        updated_by: author.to_string(),
        updated_by_label: author_label.to_string(),
        updated_at: Some(now),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionSummary {
    pub version: i64,
    pub author: String,
    pub author_label: String,
    pub note: String,
    pub created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Newest first, without the documents.
pub async fn list_versions(project_id: i64) -> Result<Vec<VersionSummary>, SaveError> {
    let rows = DbSchemaVersion::objects()
        .filter(db_schema_version::PROJECT.eq(project_id))
        .order_by(db_schema_version::VERSION.desc())
        .fetch()
        .await
        .map_err(|e| SaveError::Db(e.to_string()))?;
    Ok(rows
        .into_iter()
        .map(|r| VersionSummary {
            version: r.version,
            author: r.author,
            author_label: r.author_label,
            note: r.note,
            created_at: r.created_at,
        })
        .collect())
}

pub async fn read_version(project_id: i64, version: i64) -> Result<Option<SchemaDoc>, SaveError> {
    let row = DbSchemaVersion::objects()
        .filter(db_schema_version::PROJECT.eq(project_id) & db_schema_version::VERSION.eq(version))
        .first()
        .await
        .map_err(|e| SaveError::Db(e.to_string()))?;
    Ok(row.map(|r| serde_json::from_str(&r.doc_json).unwrap_or_default()))
}
