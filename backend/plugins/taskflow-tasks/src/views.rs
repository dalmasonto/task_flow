//! HTTP handlers for the `taskflow-tasks` plugin.

pub async fn health() -> &'static str {
    "taskflow-tasks:ok"
}
