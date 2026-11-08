use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/projects/{project}/daily-updates", get(views::list))
        .route(
            "/api/taskflow/projects/{project}/daily-updates/{date}",
            get(views::get_one).patch(views::edit),
        )
        .route("/api/taskflow/projects/{project}/daily-updates/{date}/draft", post(views::draft_now))
        .route("/api/taskflow/projects/{project}/daily-updates/{date}/post", post(views::post))
        .route("/api/taskflow/projects/{project}/daily-updates/{date}/skip", post(views::skip))
        .route("/api/taskflow/projects/{project}/daily-updates/{date}/redraft", post(views::redraft))
        .route(
            "/api/taskflow/projects/{project}/daily-update-settings",
            get(views::get_settings).put(views::put_settings),
        )
        .route("/api/taskflow/agents/daily-update/sources", get(views::agent_sources))
        .route("/api/taskflow/agents/daily-update/{date}", umbral::web::put(views::agent_write))
}
