//! HTTP handlers for the `taskflow-agents` plugin.

pub async fn health() -> &'static str {
    "taskflow-agents:ok"
}
