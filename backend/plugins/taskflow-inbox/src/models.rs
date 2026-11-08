//! #1116: the inbox's only table — how far each person has read it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use umbral::orm::ForeignKey;
use umbral_auth::AuthUser;

/// "Mark all read" moves `seen_at` to now; an item is unread when newer. The
/// inbox never writes to the rows it gathers. Written ONLY by
/// `POST /api/taskflow/inbox/read`; not exposed over auto-REST at all.
#[derive(Debug, Clone, sqlx::FromRow, Serialize, Deserialize, umbral::orm::Model)]
#[umbral(unique_together = [["user"]])]
pub struct TaskflowInboxCursor {
    pub id: i64,
    #[umbral(on_delete = "cascade")]
    pub user: ForeignKey<AuthUser>,
    pub seen_at: DateTime<Utc>,
}
