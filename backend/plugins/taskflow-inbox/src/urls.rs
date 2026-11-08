//! URL conf for `taskflow-inbox` (#1116).

use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/inbox", get(views::inbox))
        .route("/api/taskflow/inbox/read", post(views::mark_read))
}
