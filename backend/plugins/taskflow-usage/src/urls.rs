//! URL conf for `taskflow-usage` (#1115).

use umbral::web::{Router, get};

use crate::views;

pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/agents/usage", get(views::usage_as_agent).post(views::report_as_agent))
        .route("/api/taskflow/usage/{project}", get(views::usage))
        .route("/api/taskflow/usage/{project}/settings", get(views::get_settings).post(views::save_settings))
        .route("/api/taskflow/usage/{project}/prices", get(views::prices).post(views::save_price))
}
