//! #1118 endpoints. People: a project member reads; an owner or admin writes,
//! edits, posts, skips, redrafts and sets the schedule. Agents: only the
//! configured drafting agent writes, only its own project's draft, only while
//! no person has edited it.

use chrono::Utc;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use umbral::orm::ForeignKey;
use umbral::prelude::IntoResponse;
use umbral::web::{Json, Path, Query, Response, StatusCode};
use umbral_auth::RequireAuth;

use taskflow_agents::agent_auth::RequireAgent;
use taskflow_agents::models::{
    TaskflowAgent, TaskflowAgentChannel, TaskflowAgentMessage, TaskflowChannelKind, TaskflowChannelMemberKind,
    TaskflowMessagePriority, taskflow_agent, taskflow_agent_channel,
};
use taskflow_projects::models::{TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};

use crate::models::{TaskflowDailyUpdate, TaskflowDailyUpdateSettings, taskflow_daily_update};
use crate::service::{
    self, ApiError, DEFAULT_TIME, DEFAULT_TZ, MAX_BODY_CHARS, bad, err, internal, parse_date, parse_time, parse_tz,
    update_json,
};

type Reply = Result<Response, ApiError>;
const MAX_LIST: u64 = 60;

async fn member(project: i64, user: i64) -> Result<TaskflowProjectMember, ApiError> {
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::FORBIDDEN, "forbidden"))
}

async fn manager(project: i64, user: i64) -> Result<TaskflowProjectMember, ApiError> {
    let m = member(project, user).await?;
    if !matches!(m.role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin) {
        return Err(err(StatusCode::FORBIDDEN, "owner_or_admin"));
    }
    Ok(m)
}

fn date_of(s: &str) -> Result<chrono::NaiveDate, ApiError> {
    parse_date(s).ok_or_else(|| bad("date", "YYYY-MM-DD"))
}

async fn existing(project: i64, date: &str) -> Result<TaskflowDailyUpdate, ApiError> {
    date_of(date)?;
    service::find(project, date).await?.ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))
}

fn body_of(s: &str) -> Result<String, ApiError> {
    let b = s.trim();
    if b.is_empty() || b.chars().count() > MAX_BODY_CHARS {
        return Err(bad("body_markdown", &format!("1 to {MAX_BODY_CHARS} characters")));
    }
    Ok(b.to_string())
}

/// Compare-and-set on the row (status `draft`, and `version` when given),
/// then a re-save so `post_save` reaches realtime. None = the CAS lost.
async fn cas(id: i64, version: Option<i64>, mut values: Map<String, Value>) -> Result<Option<TaskflowDailyUpdate>, ApiError> {
    values.insert("updated_at".into(), json!(Utc::now()));
    let mut filter = taskflow_daily_update::ID.eq(id) & taskflow_daily_update::STATUS.eq("draft");
    if let Some(v) = version {
        filter = filter & taskflow_daily_update::VERSION.eq(v);
    }
    let n = TaskflowDailyUpdate::objects().filter(filter).update_values(values).await.map_err(internal)?;
    if n == 0 {
        return Ok(None);
    }
    let row = TaskflowDailyUpdate::objects()
        .filter(taskflow_daily_update::ID.eq(id))
        .first()
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "not_found"))?;
    Ok(Some(TaskflowDailyUpdate::objects().save(row).await.map_err(internal)?))
}

fn conflict(u: &TaskflowDailyUpdate) -> ApiError {
    (StatusCode::CONFLICT, Json(json!({ "error": "conflict", "status": u.status, "current_version": u.version })))
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub limit: Option<u64>,
}

/// `GET /api/taskflow/projects/{p}/daily-updates`
pub async fn list(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>, Query(q): Query<ListQuery>) -> Reply {
    member(project, user).await?;
    let rows = TaskflowDailyUpdate::objects()
        .filter(taskflow_daily_update::PROJECT.eq(project))
        .order_by(taskflow_daily_update::DATE.desc())
        .limit(q.limit.unwrap_or(30).clamp(1, MAX_LIST))
        .fetch()
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "updates": rows.iter().map(|u| update_json(u, false)).collect::<Vec<_>>() })).into_response())
}

/// `GET /api/taskflow/projects/{p}/daily-updates/{date}`
pub async fn get_one(RequireAuth(user): RequireAuth<i64>, Path((project, date)): Path<(i64, String)>) -> Reply {
    member(project, user).await?;
    Ok(Json(update_json(&existing(project, &date).await?, true)).into_response())
}

/// `POST /api/taskflow/projects/{p}/daily-updates/{date}/draft` — make the
/// day's draft now instead of waiting for the schedule (owner/admin).
pub async fn draft_now(RequireAuth(user): RequireAuth<i64>, Path((project, date)): Path<(i64, String)>) -> Reply {
    manager(project, user).await?;
    let (u, created) = service::ensure_draft(project, date_of(&date)?).await?;
    if created {
        if let Some(s) = service::settings_for(project).await? {
            service::ping_agent(&s, &u.date).await;
        }
    }
    let status = if created { StatusCode::CREATED } else { StatusCode::OK };
    Ok((status, Json(update_json(&u, true))).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditInput {
    pub body_markdown: String,
    pub base_version: i64,
}

/// `PATCH /api/taskflow/projects/{p}/daily-updates/{date}` — a person's edit.
pub async fn edit(
    RequireAuth(user): RequireAuth<i64>,
    Path((project, date)): Path<(i64, String)>,
    Json(input): Json<EditInput>,
) -> Reply {
    manager(project, user).await?;
    let u = existing(project, &date).await?;
    let body = body_of(&input.body_markdown)?;
    let mut v = Map::new();
    v.insert("body_markdown".into(), json!(body));
    v.insert("version".into(), json!(input.base_version + 1));
    v.insert("edit_count".into(), json!(u.edit_count + 1));
    v.insert("server_drafted".into(), json!(false));
    match cas(u.id, Some(input.base_version), v).await? {
        Some(u) => Ok(Json(update_json(&u, true)).into_response()),
        None => Err(conflict(&existing(project, &date).await?)),
    }
}

/// Where a post goes: the configured room if it is still a project-wide,
/// non-design, unarchived room of this project, else the public room.
async fn post_room(project: i64, settings: Option<&TaskflowDailyUpdateSettings>) -> Result<TaskflowAgentChannel, ApiError> {
    if let Some(id) = settings.and_then(|s| s.post_channel.as_ref()).map(|c| c.id()) {
        if let Some(c) = project_room(project, id).await? {
            return Ok(c);
        }
    }
    taskflow_agents::views::ensure_project_rooms(project)
        .await
        .map(|(public, _)| public)
        .map_err(|s| err(s, "rooms"))
}

async fn project_room(project: i64, id: i64) -> Result<Option<TaskflowAgentChannel>, ApiError> {
    Ok(TaskflowAgentChannel::objects()
        .filter(taskflow_agent_channel::ID.eq(id) & taskflow_agent_channel::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
        .filter(|c| c.kind == TaskflowChannelKind::Project && !c.is_design && !c.archived))
}

/// `POST /api/taskflow/projects/{p}/daily-updates/{date}/post` — posts the
/// draft AS the person. Compare-and-set from `draft`: it posts once.
pub async fn post(RequireAuth(user): RequireAuth<i64>, Path((project, date)): Path<(i64, String)>) -> Reply {
    let me = manager(project, user).await?;
    let u = existing(project, &date).await?;
    let settings = service::settings_for(project).await?;
    let room = post_room(project, settings.as_ref()).await?;
    let mut v = Map::new();
    v.insert("status".into(), json!("posted"));
    v.insert("posted_by".into(), json!(user));
    v.insert("posted_at".into(), json!(Utc::now()));
    let Some(posted) = cas(u.id, None, v).await? else {
        return Err(conflict(&existing(project, &date).await?));
    };
    let message = TaskflowAgentMessage::objects()
        .create(TaskflowAgentMessage {
            thread_root: None,
            in_channel: true,
            id: 0,
            project: room.project.clone(),
            channel: ForeignKey::new(room.id),
            task: None,
            sender_kind: TaskflowChannelMemberKind::User,
            sender_user: Some(ForeignKey::new(user)),
            sender_agent: None,
            target_agent: None,
            targets: None,
            sender_label: me.display_name.clone(),
            body_markdown: format!("**Daily update, {}**\n\n{}", posted.date, posted.body_markdown),
            priority: TaskflowMessagePriority::Normal,
            is_design: room.is_design,
            client_nonce: None,
            edited_at: None,
            reply_to: None,
            questions: None,
            created_at: None,
        })
        .await;
    let mut posted = posted;
    match message {
        Ok(m) => {
            posted.posted_message = Some(m.id);
            let posted = TaskflowDailyUpdate::objects().save(posted).await.map_err(internal)?;
            Ok(Json(update_json(&posted, true)).into_response())
        }
        Err(e) => {
            // Put it back to draft so the person can try again.
            posted.status = crate::models::TaskflowDailyUpdateStatus::Draft;
            posted.posted_by = None;
            posted.posted_at = None;
            let _ = TaskflowDailyUpdate::objects().save(posted).await;
            Err(internal(e))
        }
    }
}

/// `POST /api/taskflow/projects/{p}/daily-updates/{date}/skip`
pub async fn skip(RequireAuth(user): RequireAuth<i64>, Path((project, date)): Path<(i64, String)>) -> Reply {
    manager(project, user).await?;
    let u = existing(project, &date).await?;
    let mut v = Map::new();
    v.insert("status".into(), json!("skipped"));
    match cas(u.id, None, v).await? {
        Some(u) => Ok(Json(update_json(&u, true)).into_response()),
        None => Err(conflict(&existing(project, &date).await?)),
    }
}

/// `POST /api/taskflow/projects/{p}/daily-updates/{date}/redraft` — throw the
/// text away and rebuild it from the sources (a person's explicit choice, so
/// it also clears `edit_count`), then ask the drafting agent again.
pub async fn redraft(RequireAuth(user): RequireAuth<i64>, Path((project, date)): Path<(i64, String)>) -> Reply {
    manager(project, user).await?;
    let u = existing(project, &date).await?;
    let settings = service::settings_for(project).await?;
    let (tz, _) = service::clock(settings.as_ref());
    let (start, end) = service::window(tz, date_of(&date)?, Utc::now());
    let src = service::sources(project, tz, start, end).await?;
    let mut v = Map::new();
    v.insert("body_markdown".into(), json!(service::server_draft(&src)));
    v.insert("version".into(), json!(u.version + 1));
    v.insert("edit_count".into(), json!(0));
    v.insert("server_drafted".into(), json!(true));
    v.insert("drafted_by_label".into(), json!(service::SERVER_LABEL));
    v.insert("window_start".into(), json!(start));
    v.insert("window_end".into(), json!(end));
    for (k, f) in [("src_activity", "activity"), ("src_task_changes", "task_changes"), ("src_reviews", "reviews"), ("src_pull_requests", "pull_requests")] {
        v.insert(k.into(), src["counts"][f].clone());
    }
    let Some(u) = cas(u.id, Some(u.version), v).await? else {
        return Err(conflict(&existing(project, &date).await?));
    };
    if let Some(s) = settings {
        service::ping_agent(&s, &u.date).await;
    }
    Ok(Json(update_json(&u, true)).into_response())
}

fn settings_json(s: Option<&TaskflowDailyUpdateSettings>) -> Value {
    json!({
        "enabled": s.is_some_and(|s| s.enabled),
        "local_time": s.map(|s| s.local_time.clone()).unwrap_or_else(|| DEFAULT_TIME.into()),
        "timezone": s.map(|s| s.timezone.clone()).unwrap_or_else(|| DEFAULT_TZ.into()),
        "drafting_agent": s.and_then(|s| s.drafting_agent.as_ref().map(|a| a.id())),
        "post_channel": s.and_then(|s| s.post_channel.as_ref().map(|c| c.id())),
        "updated_by_label": s.map(|s| s.updated_by_label.clone()),
        "updated_at": s.and_then(|s| s.updated_at),
    })
}

/// `GET /api/taskflow/projects/{p}/daily-update-settings`
pub async fn get_settings(RequireAuth(user): RequireAuth<i64>, Path(project): Path<i64>) -> Reply {
    member(project, user).await?;
    Ok(Json(settings_json(service::settings_for(project).await?.as_ref())).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInput {
    pub enabled: bool,
    pub local_time: String,
    pub timezone: String,
    #[serde(default)]
    pub drafting_agent: Option<i64>,
    #[serde(default)]
    pub post_channel: Option<i64>,
}

/// `PUT /api/taskflow/projects/{p}/daily-update-settings` (owner/admin)
pub async fn put_settings(
    RequireAuth(user): RequireAuth<i64>,
    Path(project): Path<i64>,
    Json(input): Json<SettingsInput>,
) -> Reply {
    let me = manager(project, user).await?;
    parse_time(&input.local_time).ok_or_else(|| bad("local_time", "HH:MM, 24-hour"))?;
    parse_tz(&input.timezone).ok_or_else(|| bad("timezone", "an IANA name such as Africa/Nairobi"))?;
    if let Some(a) = input.drafting_agent {
        TaskflowAgent::objects()
            .filter(taskflow_agent::ID.eq(a) & taskflow_agent::PROJECT.eq(project))
            .first()
            .await
            .map_err(internal)?
            .filter(|a| a.status != taskflow_agents::models::TaskflowAgentStatus::Revoked)
            .ok_or_else(|| bad("drafting_agent", "not an agent of this project"))?;
    }
    if let Some(c) = input.post_channel {
        project_room(project, c).await?.ok_or_else(|| bad("post_channel", "a project-wide room of this project (not the design room)"))?;
    }
    let mut s = service::settings_for(project).await?.unwrap_or(TaskflowDailyUpdateSettings {
        id: 0,
        project: ForeignKey::new(project),
        enabled: false,
        local_time: DEFAULT_TIME.into(),
        timezone: DEFAULT_TZ.into(),
        drafting_agent: None,
        post_channel: None,
        updated_by_label: String::new(),
        updated_at: None,
    });
    s.enabled = input.enabled;
    s.local_time = input.local_time;
    s.timezone = input.timezone;
    s.drafting_agent = input.drafting_agent.map(ForeignKey::new);
    s.post_channel = input.post_channel.map(ForeignKey::new);
    s.updated_by_label = me.display_name;
    s.updated_at = Some(Utc::now());
    let s = if s.id == 0 {
        TaskflowDailyUpdateSettings::objects().create(s).await.map_err(internal)?
    } else {
        TaskflowDailyUpdateSettings::objects().save(s).await.map_err(internal)?
    };
    Ok(Json(settings_json(Some(&s))).into_response())
}

/// The drafting agent, or 403: only the agent named in the settings drafts.
async fn drafting(agent: &taskflow_agents::agent_auth::AgentIdentity) -> Result<(), ApiError> {
    let s = service::settings_for(agent.project_id).await?;
    if s.and_then(|s| s.drafting_agent.map(|a| a.id())) != Some(agent.agent_id) {
        return Err(err(StatusCode::FORBIDDEN, "not_drafting_agent"));
    }
    Ok(())
}

#[derive(Debug, Default, Deserialize)]
pub struct SourcesQuery {
    pub date: Option<String>,
}

/// `GET /api/taskflow/agents/daily-update/sources?date=` — the drafting agent.
pub async fn agent_sources(RequireAgent(agent): RequireAgent, Query(q): Query<SourcesQuery>) -> Reply {
    drafting(&agent).await?;
    let date = date_of(q.date.as_deref().unwrap_or_default())?;
    let s = service::settings_for(agent.project_id).await?;
    let (tz, _) = service::clock(s.as_ref());
    let (start, end) = service::window(tz, date, Utc::now());
    let mut src = service::sources(agent.project_id, tz, start, end).await?;
    src["date"] = json!(date.format("%Y-%m-%d").to_string());
    Ok(Json(src).into_response())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentDraftInput {
    pub body_markdown: String,
}

/// `PUT /api/taskflow/agents/daily-update/{date}` — the drafting agent rewrites
/// its project's draft. Refused once a person has edited it.
pub async fn agent_write(RequireAgent(agent): RequireAgent, Path(date): Path<String>, Json(input): Json<AgentDraftInput>) -> Reply {
    agent
        .require(taskflow_agents::scopes::TASKS_WRITE)
        .map_err(taskflow_agents::scopes::CapabilityError::into_status_json)?;
    drafting(&agent).await?;
    let (u, _) = service::ensure_draft(agent.project_id, date_of(&date)?).await?;
    if u.edit_count > 0 {
        return Err(err(StatusCode::CONFLICT, "edited_by_person"));
    }
    let body = body_of(&input.body_markdown)?;
    let mut v = Map::new();
    v.insert("body_markdown".into(), json!(body));
    v.insert("version".into(), json!(u.version + 1));
    v.insert("server_drafted".into(), json!(false));
    v.insert("drafted_by_label".into(), json!(agent.display_name));
    // Version-guarded: a person's edit that lands first wins.
    match cas(u.id, Some(u.version), v).await? {
        Some(u) => Ok(Json(update_json(&u, true)).into_response()),
        None => Err(conflict(&existing(agent.project_id, &date).await?)),
    }
}
