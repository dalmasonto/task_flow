//! Agent routes (#885), under `/api/taskflow/agents/db/...`, behind the MCP's
//! `db_*` tools. An agent writes ONE model at a time with the version it read;
//! a field a person changed is locked, and a write that would change or drop it
//! is refused (naming the field) unless the agent sends `override: true`.

use serde::Deserialize;
use serde_json::json;
use umbral::web::{IntoResponse, Json, Query, Response, StatusCode};

use taskflow_agents::agent_auth::{AgentIdentity, RequireAgent};

use crate::schema_doc::{Author, Model, apply_agent_model, delete_model_as_agent, referrers};
use crate::store::{self, SaveError};
use crate::views::{current_json, save_error};

fn same_project(agent: &AgentIdentity, project: i64) -> Result<(), Response> {
    if agent.project_id == project {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN.into_response())
    }
}

fn author(agent: &AgentIdentity) -> (String, Author) {
    (format!("agent:{}", agent.agent_id), Author::agent(agent.agent_id, &agent.display_name))
}

#[derive(Debug, Deserialize)]
pub struct SchemaQuery {
    pub project: i64,
    /// One model only, with what points at it.
    pub model: Option<String>,
}

/// `GET /api/taskflow/agents/db/schema?project=&model=`
pub async fn schema(RequireAgent(agent): RequireAgent, Query(q): Query<SchemaQuery>) -> Response {
    if let Err(r) = same_project(&agent, q.project) {
        return r;
    }
    let current = match store::load(q.project).await {
        Ok(c) => c,
        Err(e) => return save_error(e),
    };
    let note = "Fields with locked_by_user: true were changed by a person; do not change or remove them without asking. \
                Write one model at a time with db_write_model and the version you read as base_version.";
    match q.model {
        Some(name) => match current.doc.models.iter().find(|m| m.name == name) {
            Some(m) => Json(json!({
                "version": current.version,
                "model": m,
                "referenced_by": referrers(&current.doc, &name)
                    .into_iter()
                    .map(|(model, field)| json!({ "model": model, "field": field }))
                    .collect::<Vec<_>>(),
                "note": note,
            }))
            .into_response(),
            None => save_error(SaveError::NotFound(format!("no model `{name}`; read the schema without `model` to list them"))),
        },
        None => {
            let mut body = current_json(&current);
            body["note"] = json!(note);
            Json(body).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WriteModelInput {
    pub project: i64,
    pub base_version: i64,
    pub model: Model,
    #[serde(default, rename = "override")]
    pub override_locks: bool,
}

/// `PUT /api/taskflow/agents/db/model` — create or replace one model.
pub async fn write_model(RequireAgent(agent): RequireAgent, Json(input): Json<WriteModelInput>) -> Response {
    if let Err(r) = same_project(&agent, input.project) {
        return r;
    }
    let (key, who) = author(&agent);
    let name = input.model.name.clone();
    let force = input.override_locks;
    let res = store::save(input.project, Some(input.base_version), &key, &agent.display_name, |prev| {
        let existed = prev.models.iter().any(|m| m.name == name);
        let next = apply_agent_model(prev, input.model, &who, force).map_err(SaveError::Locked)?;
        let verb = if existed { "updated" } else { "added" };
        let forced = if force { " (overrode a person's lock)" } else { "" };
        Ok((next, format!("{} {verb} {name}{forced}", agent.display_name)))
    })
    .await;
    match res {
        Ok(c) => {
            // A person's lock was overridden: say so where they will see it.
            if force {
                crate::room::post_agent_note(
                    input.project,
                    agent.agent_id,
                    &agent.display_name,
                    format!("I overrode your lock on `{name}` (schema v{}). Check the change in the Database page; Versions can restore the old one.", c.version),
                )
                .await;
            }
            Json(current_json(&c)).into_response()
        }
        Err(e) => save_error(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteModelQuery {
    pub project: i64,
    pub name: String,
    pub base_version: i64,
    #[serde(default, rename = "override")]
    pub override_locks: bool,
}

/// `DELETE /api/taskflow/agents/db/model?project=&name=&base_version=`
pub async fn delete_model(RequireAgent(agent): RequireAgent, Query(q): Query<DeleteModelQuery>) -> Response {
    if let Err(r) = same_project(&agent, q.project) {
        return r;
    }
    let (key, _) = author(&agent);
    let name = q.name.clone();
    let res = store::save(q.project, Some(q.base_version), &key, &agent.display_name, |prev| {
        let refs = referrers(prev, &name);
        if let Some((model, field)) = refs.iter().find(|(m, _)| *m != name) {
            return Err(SaveError::Invalid(vec![format!(
                "`{model}.{field}` still points at `{name}`; change or remove that field first"
            )]));
        }
        match delete_model_as_agent(prev, &name, q.override_locks) {
            None => Err(SaveError::NotFound(format!("no model `{name}`"))),
            Some(Err(conflict)) => Err(SaveError::Locked(conflict)),
            Some(Ok(next)) => Ok((next, format!("{} removed {name}", agent.display_name))),
        }
    })
    .await;
    match res {
        Ok(c) => Json(current_json(&c)).into_response(),
        Err(e) => save_error(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct SamplesInput {
    pub project: i64,
    pub base_version: i64,
    pub model: String,
    pub rows: Vec<std::collections::BTreeMap<String, serde_json::Value>>,
}

/// `PUT /api/taskflow/agents/db/samples` — replace one model's sample rows.
/// Rows are checked against the model's fields by the document validation.
pub async fn write_samples(RequireAgent(agent): RequireAgent, Json(input): Json<SamplesInput>) -> Response {
    if let Err(r) = same_project(&agent, input.project) {
        return r;
    }
    let (key, _) = author(&agent);
    let name = input.model.clone();
    let res = store::save(input.project, Some(input.base_version), &key, &agent.display_name, |prev| {
        let mut next = prev.clone();
        let model = next
            .models
            .iter_mut()
            .find(|m| m.name == name)
            .ok_or_else(|| SaveError::NotFound(format!("no model `{name}`")))?;
        let n = input.rows.len();
        model.samples = input.rows;
        Ok((next, format!("{} wrote {n} sample row(s) for {name}", agent.display_name)))
    })
    .await;
    match res {
        Ok(c) => Json(current_json(&c)).into_response(),
        Err(e) => save_error(e),
    }
}
