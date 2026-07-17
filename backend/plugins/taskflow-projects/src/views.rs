//! HTTP handlers for the `taskflow-projects` plugin.

pub async fn health() -> &'static str {
    "taskflow-projects:ok"
}
