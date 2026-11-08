//! Fire `post_save` for a row written by `update_values`.
//!
//! The lost-update-safe way to change a few columns is a guarded
//! `update_values`, but it fires only `bulk_post_save` (ids), and realtime's
//! `expose` listens on `post_save:<table>`. So after a column update, read the
//! row back and emit `post_save` for it here: realtime hears the change and
//! nothing is written a second time.
//!
//! A copy of umbral's own emit (same name and `{instance, created}` payload,
//! `SIGNAL_SKIP_FIELDS` stripped), which the `umbral` facade does not
//! re-export: umbra gaps6 #27. The ONE copy (taskflow-agents re-exports it;
//! design and agents use it); delete it
//! when that lands.

use serde_json::{Value, json};

pub async fn emit_post_save<M>(row: &M)
where
    M: umbral::orm::Model + serde::Serialize,
{
    let Ok(mut instance) = serde_json::to_value(row) else { return };
    if let Value::Object(map) = &mut instance {
        for field in M::SIGNAL_SKIP_FIELDS {
            map.remove(*field);
        }
    }
    umbral::signals::emit(&format!("post_save:{}", M::TABLE), json!({ "instance": instance, "created": false })).await;
}

