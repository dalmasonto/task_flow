//! Usage and cost: ingest, pricing, aggregates, budget and alerts (#1115).

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use umbral::orm::ForeignKey;
use umbral::web::{Json, StatusCode};

use taskflow_projects::models::{TaskflowProjectMember, TaskflowProjectRole, taskflow_project_member};
use taskflow_tasks::models::{TaskflowTask, taskflow_task};

use crate::models::{
    TaskflowModelPrice, TaskflowUsageAlert, TaskflowUsageReport, TaskflowUsageSettings,
    taskflow_model_price, taskflow_usage_report, taskflow_usage_settings,
};

pub type ApiError = (StatusCode, Json<Value>);

pub fn err(status: StatusCode, code: &str) -> ApiError {
    (status, Json(json!({ "error": code })))
}

pub fn bad(field: &str, reason: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid", "field": field, "reason": reason })))
}

fn internal<E>(_: E) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal")
}

/// One report may not claim more than this per counter: a guard against a
/// buggy or hostile client, far above any real turn.
pub const MAX_TOKENS_PER_COUNTER: i64 = 50_000_000;
const MICROS: i64 = 1_000_000;

// ---------------------------------------------------------------------------
// Seeded prices — ONLY figures we can cite. Every other component is NULL and
// makes a report that needs it "unpriced" (lead review #MSG5706).
// ---------------------------------------------------------------------------

pub const SEED_SOURCE: &str = "Anthropic API list price (first-party), claude-api reference";
pub const SEED_AS_OF: &str = "2026-10-06";

/// Tiers from the same cited table: (prefix, above prompt tokens, input, output).
const SEED_TIERS: &[(&str, i64, f64, f64)] = &[
    // Haiku 5.5: $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 beyond.
    ("claude-haiku-5-5", 100_000, 0.50, 2.50),
];

/// (prefix, name, input, output, cache read) in USD per million tokens. Cache
/// write is not in the cited table, so it is NULL everywhere.
const SEED: &[(&str, &str, f64, f64, Option<f64>)] = &[
    ("claude-fable-5-1", "Claude Fable 5.1", 10.0, 50.0, Some(0.25)),
    ("claude-fable-5", "Claude Fable 5", 10.0, 50.0, None),
    ("claude-opus-5-5", "Claude Opus 5.5", 4.0, 20.0, Some(0.20)),
    ("claude-opus-5", "Claude Opus 5", 5.0, 25.0, None),
    ("claude-opus-4-8", "Claude Opus 4.8", 5.0, 25.0, None),
    ("claude-opus-4-7", "Claude Opus 4.7", 5.0, 25.0, None),
    ("claude-opus-4-6", "Claude Opus 4.6", 5.0, 25.0, None),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", 2.0, 10.0, Some(0.20)),
    ("claude-sonnet-5", "Claude Sonnet 5", 2.0, 10.0, None),
    ("claude-sonnet-4-6", "Claude Sonnet 4.6", 3.0, 15.0, None),
    // Haiku 5.5 is tiered by prompt size; this is the ≤100K-token rate.
    ("claude-haiku-5-5", "Claude Haiku 5.5", 0.10, 0.50, None),
    ("claude-haiku-4-5", "Claude Haiku 4.5", 1.0, 5.0, None),
];

fn usd(v: f64) -> i64 {
    (v * MICROS as f64).round() as i64
}

/// Insert any missing default row. Idempotent; never overwrites an edit.
pub async fn seed_prices() {
    for (prefix, name, input, output, cache_read) in SEED {
        let exists = TaskflowModelPrice::objects()
            .filter(taskflow_model_price::PROJECT.is_null() & taskflow_model_price::MODEL_PREFIX.eq(*prefix))
            .exists()
            .await
            .unwrap_or(true);
        if exists {
            continue;
        }
        let tier = SEED_TIERS.iter().find(|t| t.0 == *prefix);
        let _ = TaskflowModelPrice::objects()
            .create(TaskflowModelPrice {
                id: 0,
                project: None,
                model_prefix: prefix.to_string(),
                display_name: name.to_string(),
                input_micros_per_mtok: Some(usd(*input)),
                output_micros_per_mtok: Some(usd(*output)),
                cache_read_micros_per_mtok: cache_read.map(usd),
                cache_write_micros_per_mtok: None,
                tier_above_prompt_tokens: tier.map(|t| t.1),
                tier_input_micros_per_mtok: tier.map(|t| usd(t.2)),
                tier_output_micros_per_mtok: tier.map(|t| usd(t.3)),
                tier_cache_read_micros_per_mtok: None,
                tier_cache_write_micros_per_mtok: None,
                source: SEED_SOURCE.to_string(),
                as_of: SEED_AS_OF.to_string(),
                updated_by_label: "seed".to_string(),
                updated_at: Some(Utc::now()),
            })
            .await;
    }
}

/// The price for `model` in `project`: the project's rows first, then the
/// defaults; within each, the LONGEST matching prefix (so "claude-opus-5-5"
/// beats "claude-opus-5").
pub async fn price_for(project: i64, model: &str) -> Option<TaskflowModelPrice> {
    let rows = TaskflowModelPrice::objects().fetch().await.unwrap_or_default();
    let best = |rows: Vec<&TaskflowModelPrice>| rows.into_iter().max_by_key(|p| p.model_prefix.len()).cloned();
    let matching: Vec<&TaskflowModelPrice> = rows.iter().filter(|p| model.starts_with(&p.model_prefix)).collect();
    best(matching.iter().copied().filter(|p| p.project.as_ref().map(|x| x.id()) == Some(project)).collect())
        .or_else(|| best(matching.iter().copied().filter(|p| p.project.is_none()).collect()))
}

/// micro-dollars for one report, or None when any NEEDED component is unknown.
pub fn cost(p: &TaskflowModelPrice, input: i64, output: i64, cache_read: i64, cache_write: i64) -> Option<i64> {
    let prompt = input + cache_read + cache_write;
    let upper = p.tier_above_prompt_tokens.is_some_and(|t| prompt > t);
    let (pi, po, pr, pw) = if upper {
        (p.tier_input_micros_per_mtok, p.tier_output_micros_per_mtok, p.tier_cache_read_micros_per_mtok, p.tier_cache_write_micros_per_mtok)
    } else {
        (p.input_micros_per_mtok, p.output_micros_per_mtok, p.cache_read_micros_per_mtok, p.cache_write_micros_per_mtok)
    };
    let part = |tokens: i64, price: Option<i64>| -> Option<i128> {
        if tokens == 0 {
            Some(0)
        } else {
            price.map(|per| tokens as i128 * per as i128 / MICROS as i128)
        }
    };
    let total = part(input, pi)? + part(output, po)? + part(cache_read, pr)? + part(cache_write, pw)?;
    i64::try_from(total).ok()
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/// The report body: counts, model and turn id ONLY. `deny_unknown_fields` is
/// the guarantee that a later "helpful" client change cannot start shipping
/// transcript text to the server (lead review #MSG5706) — an extra field is a 400.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportInput {
    pub turn_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(default)]
    pub cache_read_tokens: i64,
    #[serde(default)]
    pub cache_write_tokens: i64,
}

pub fn parse_report(body: Value) -> Result<ReportInput, ApiError> {
    let input: ReportInput = serde_json::from_value(body).map_err(|e| {
        let msg = e.to_string();
        let field = msg
            .split('`')
            .nth(1)
            .unwrap_or("body")
            .to_string();
        bad(&field, "only turn_id, model and the four token counts are accepted")
    })?;
    let id_ok = |s: &str| !s.is_empty() && s.len() <= 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c));
    if !id_ok(&input.turn_id) {
        return Err(bad("turn_id", "1-120 characters of letters, digits and -_.:/@"));
    }
    if !id_ok(&input.model) {
        return Err(bad("model", "a model id, 1-120 characters"));
    }
    for (name, v) in [
        ("input_tokens", input.input_tokens),
        ("output_tokens", input.output_tokens),
        ("cache_read_tokens", input.cache_read_tokens),
        ("cache_write_tokens", input.cache_write_tokens),
    ] {
        if !(0..=MAX_TOKENS_PER_COUNTER).contains(&v) {
            return Err(bad(name, &format!("0 to {MAX_TOKENS_PER_COUNTER}")));
        }
    }
    Ok(input)
}

/// The agent's current in-progress task, decided here, not by the client.
async fn current_task(agent: i64, project: i64) -> Option<i64> {
    TaskflowTask::objects()
        .filter(
            taskflow_task::PROJECT.eq(project)
                & taskflow_task::ASSIGNED_AGENT_ID.eq(agent)
                & taskflow_task::STATUS.eq("in_progress"),
        )
        .order_by(taskflow_task::UPDATED_AT.desc())
        .first()
        .await
        .ok()
        .flatten()
        .map(|t| t.id)
}

pub fn report_json(r: &TaskflowUsageReport) -> Value {
    json!({
        "id": r.id, "agent": r.agent.id(), "task": r.task, "model": r.model, "turn_id": r.turn_id,
        "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
        "cache_read_tokens": r.cache_read_tokens, "cache_write_tokens": r.cache_write_tokens,
        "cost_micros": r.cost_micros, "priced": r.cost_micros.is_some(), "reported_at": r.reported_at,
    })
}

/// Store one report (idempotent on `(agent, turn_id)`), then run the alerts.
pub async fn ingest(project: i64, agent: i64, input: ReportInput) -> Result<(bool, Value), ApiError> {
    let existing = TaskflowUsageReport::objects()
        .filter(taskflow_usage_report::AGENT.eq(agent) & taskflow_usage_report::TURN_ID.eq(input.turn_id.as_str()))
        .first()
        .await
        .map_err(internal)?;
    if let Some(r) = existing {
        return Ok((false, report_json(&r)));
    }
    let price = price_for(project, &input.model).await;
    let cost_micros = price
        .as_ref()
        .and_then(|p| cost(p, input.input_tokens, input.output_tokens, input.cache_read_tokens, input.cache_write_tokens));
    let task = current_task(agent, project).await;
    let report = TaskflowUsageReport::objects()
        .create(TaskflowUsageReport {
            id: 0,
            project: ForeignKey::new(project),
            agent: ForeignKey::new(agent),
            task,
            model: input.model,
            turn_id: input.turn_id,
            input_tokens: input.input_tokens,
            output_tokens: input.output_tokens,
            cache_read_tokens: input.cache_read_tokens,
            cache_write_tokens: input.cache_write_tokens,
            cost_micros,
            price_id: price.map(|p| p.id),
            reported_at: Utc::now(),
        })
        .await
        // A racing duplicate hits the unique index: report it as the existing one.
        .map_err(|_| err(StatusCode::CONFLICT, "duplicate_turn"))?;
    check_alerts(project, &report).await;
    Ok((true, report_json(&report)))
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub agent: Option<i64>,
}

#[derive(Debug, Default, Serialize, Clone)]
struct Bucket {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    cost_micros: i64,
    unpriced_reports: i64,
    reports: i64,
}

impl Bucket {
    fn add(&mut self, r: &TaskflowUsageReport) {
        self.input_tokens += r.input_tokens;
        self.output_tokens += r.output_tokens;
        self.cache_read_tokens += r.cache_read_tokens;
        self.cache_write_tokens += r.cache_write_tokens;
        self.reports += 1;
        match r.cost_micros {
            Some(c) => self.cost_micros += c,
            None => self.unpriced_reports += 1,
        }
    }
}

fn month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).single().unwrap_or(now)
}

fn next_month_start(now: DateTime<Utc>) -> DateTime<Utc> {
    let (y, m) = if now.month() == 12 { (now.year() + 1, 1) } else { (now.year(), now.month() + 1) };
    Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0).single().unwrap_or(now)
}

async fn reports_between(project: i64, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<TaskflowUsageReport>, ApiError> {
    TaskflowUsageReport::objects()
        .filter(
            taskflow_usage_report::PROJECT.eq(project)
                & taskflow_usage_report::REPORTED_AT.gte(from)
                & taskflow_usage_report::REPORTED_AT.lt(to),
        )
        .fetch()
        .await
        .map_err(internal)
}

pub async fn usage(project: i64, q: &UsageQuery) -> Result<Value, ApiError> {
    let now = Utc::now();
    let to = q.to.unwrap_or(now);
    let from = q.from.unwrap_or(to - Duration::days(14));
    if from >= to || to - from > Duration::days(400) {
        return Err(bad("from", "a range of at most 400 days, from before to"));
    }
    let group = q.group.as_deref().unwrap_or("day");
    if !["day", "model", "agent", "task"].contains(&group) {
        return Err(bad("group", "day, model, agent or task"));
    }
    let mut rows = reports_between(project, from, to).await?;
    if let Some(agent) = q.agent {
        rows.retain(|r| r.agent.id() == agent);
    }
    let mut total = Bucket::default();
    let mut groups: BTreeMap<String, Bucket> = BTreeMap::new();
    for r in &rows {
        total.add(r);
        let key = match group {
            "day" => r.reported_at.format("%Y-%m-%d").to_string(),
            "model" => r.model.clone(),
            "agent" => r.agent.id().to_string(),
            _ => r.task.map(|t| t.to_string()).unwrap_or_else(|| "none".to_string()),
        };
        groups.entry(key).or_default().add(r);
    }

    // Budget and the run-rate projection for the CURRENT month.
    let settings = settings_for(project).await?;
    let (ms, me) = (month_start(now), next_month_start(now));
    let month: i64 = reports_between(project, ms, now + Duration::seconds(1))
        .await?
        .iter()
        .filter_map(|r| r.cost_micros)
        .sum();
    let elapsed = (now - ms).num_seconds().max(1);
    let whole = (me - ms).num_seconds();
    let projected = (month as i128 * whole as i128 / elapsed as i128) as i64;

    Ok(json!({
        "self_reported": true,
        "note": "Reported by each agent's MCP. For awareness, not billing.",
        "from": from, "to": to, "group": group,
        "total": total,
        "groups": groups.into_iter().map(|(k, b)| json!({ "key": k, "usage": b })).collect::<Vec<_>>(),
        "month": {
            "start": ms, "spend_micros": month, "projected_micros": projected,
            "budget_micros": settings.budget_micros,
        },
    }))
}

// ---------------------------------------------------------------------------
// Settings and prices
// ---------------------------------------------------------------------------

pub async fn settings_for(project: i64) -> Result<TaskflowUsageSettings, ApiError> {
    if let Some(s) = TaskflowUsageSettings::objects()
        .filter(taskflow_usage_settings::PROJECT.eq(project))
        .first()
        .await
        .map_err(internal)?
    {
        return Ok(s);
    }
    Ok(TaskflowUsageSettings {
        id: 0,
        project: ForeignKey::new(project),
        budget_micros: None,
        alert_percent: None,
        alert_channel: None,
        task_cap_micros: None,
        idle_alert: false,
        budget_alerted_month: None,
        updated_by_label: String::new(),
        updated_at: None,
    })
}

pub fn settings_json(s: &TaskflowUsageSettings) -> Value {
    json!({
        "budget_micros": s.budget_micros, "alert_percent": s.alert_percent,
        "alert_channel": s.alert_channel.as_ref().map(|c| c.id()),
        "task_cap_micros": s.task_cap_micros, "idle_alert": s.idle_alert,
        "updated_by_label": s.updated_by_label, "updated_at": s.updated_at,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsInput {
    #[serde(default)]
    pub budget_micros: Option<i64>,
    #[serde(default)]
    pub alert_percent: Option<i64>,
    #[serde(default)]
    pub alert_channel: Option<i64>,
    #[serde(default)]
    pub task_cap_micros: Option<i64>,
    #[serde(default)]
    pub idle_alert: bool,
}

pub async fn save_settings(project: i64, user: i64, label: &str, input: SettingsInput) -> Result<Value, ApiError> {
    for (name, v) in [("budget_micros", input.budget_micros), ("task_cap_micros", input.task_cap_micros)] {
        if v.is_some_and(|v| !(0..=1_000_000 * MICROS).contains(&v)) {
            return Err(bad(name, "0 to $1,000,000"));
        }
    }
    if input.alert_percent.is_some_and(|p| !(1..=100).contains(&p)) {
        return Err(bad("alert_percent", "1 to 100"));
    }
    if let Some(c) = input.alert_channel {
        taskflow_agents::views::ensure_channel_visible(user, c)
            .await
            .map_err(|_| bad("alert_channel", "a channel in this project you can see"))?;
    }
    let mut s = settings_for(project).await?;
    s.budget_micros = input.budget_micros;
    s.alert_percent = input.alert_percent;
    s.alert_channel = input.alert_channel.map(ForeignKey::new);
    s.task_cap_micros = input.task_cap_micros;
    s.idle_alert = input.idle_alert;
    s.updated_by_label = label.to_string();
    s.updated_at = Some(Utc::now());
    let s = if s.id == 0 {
        TaskflowUsageSettings::objects().create(s).await.map_err(internal)?
    } else {
        TaskflowUsageSettings::objects().save(s).await.map_err(internal)?
    };
    Ok(settings_json(&s))
}

pub fn price_json(p: &TaskflowModelPrice) -> Value {
    json!({
        "id": p.id, "project": p.project.as_ref().map(|x| x.id()), "default": p.project.is_none(),
        "model_prefix": p.model_prefix, "display_name": p.display_name,
        "input_micros_per_mtok": p.input_micros_per_mtok, "output_micros_per_mtok": p.output_micros_per_mtok,
        "cache_read_micros_per_mtok": p.cache_read_micros_per_mtok, "cache_write_micros_per_mtok": p.cache_write_micros_per_mtok,
        "tier_above_prompt_tokens": p.tier_above_prompt_tokens,
        "tier_input_micros_per_mtok": p.tier_input_micros_per_mtok, "tier_output_micros_per_mtok": p.tier_output_micros_per_mtok,
        "tier_cache_read_micros_per_mtok": p.tier_cache_read_micros_per_mtok, "tier_cache_write_micros_per_mtok": p.tier_cache_write_micros_per_mtok,
        "source": p.source, "as_of": p.as_of, "updated_by_label": p.updated_by_label, "updated_at": p.updated_at,
    })
}

pub async fn prices(project: i64) -> Result<Value, ApiError> {
    let mut rows: Vec<TaskflowModelPrice> = TaskflowModelPrice::objects()
        .fetch()
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|p| p.project.is_none() || p.project.as_ref().map(|x| x.id()) == Some(project))
        .collect();
    rows.sort_by(|a, b| a.model_prefix.cmp(&b.model_prefix).then(a.project.is_none().cmp(&b.project.is_none())));
    Ok(json!({ "results": rows.iter().map(price_json).collect::<Vec<_>>() }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PriceInput {
    pub model_prefix: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub input_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub output_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub cache_read_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub cache_write_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub tier_above_prompt_tokens: Option<i64>,
    #[serde(default)]
    pub tier_input_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub tier_output_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub tier_cache_read_micros_per_mtok: Option<i64>,
    #[serde(default)]
    pub tier_cache_write_micros_per_mtok: Option<i64>,
    /// Required: where the figure comes from.
    pub source: String,
    /// Required: when it was true.
    pub as_of: String,
}

/// Set this project's price for a model prefix (overrides the default). A
/// source and an as-of date are required, so every figure can be checked.
pub async fn save_price(project: i64, label: &str, input: PriceInput) -> Result<Value, ApiError> {
    let prefix = input.model_prefix.trim().to_string();
    if prefix.is_empty() || prefix.len() > 120 {
        return Err(bad("model_prefix", "1-120 characters"));
    }
    if input.source.trim().is_empty() || input.source.len() > 300 {
        return Err(bad("source", "say where the price comes from"));
    }
    if chrono::NaiveDate::parse_from_str(&format!("{}-01", input.as_of.trim()), "%Y-%m-%d").is_err()
        && chrono::NaiveDate::parse_from_str(input.as_of.trim(), "%Y-%m-%d").is_err()
    {
        return Err(bad("as_of", "YYYY-MM or YYYY-MM-DD"));
    }
    for (name, v) in [
        ("input_micros_per_mtok", input.input_micros_per_mtok),
        ("output_micros_per_mtok", input.output_micros_per_mtok),
        ("cache_read_micros_per_mtok", input.cache_read_micros_per_mtok),
        ("cache_write_micros_per_mtok", input.cache_write_micros_per_mtok),
        ("tier_input_micros_per_mtok", input.tier_input_micros_per_mtok),
        ("tier_output_micros_per_mtok", input.tier_output_micros_per_mtok),
        ("tier_cache_read_micros_per_mtok", input.tier_cache_read_micros_per_mtok),
        ("tier_cache_write_micros_per_mtok", input.tier_cache_write_micros_per_mtok),
    ] {
        if v.is_some_and(|v| !(0..=10_000 * MICROS).contains(&v)) {
            return Err(bad(name, "0 to $10,000 per million tokens"));
        }
    }
    if input.tier_above_prompt_tokens.is_some_and(|t| !(1..=100_000_000).contains(&t)) {
        return Err(bad("tier_above_prompt_tokens", "1 to 100,000,000"));
    }
    let existing = TaskflowModelPrice::objects()
        .filter(taskflow_model_price::PROJECT.eq(project) & taskflow_model_price::MODEL_PREFIX.eq(prefix.as_str()))
        .first()
        .await
        .map_err(internal)?;
    let row = TaskflowModelPrice {
        id: existing.as_ref().map_or(0, |p| p.id),
        project: Some(ForeignKey::new(project)),
        display_name: input.display_name.unwrap_or_else(|| prefix.clone()),
        model_prefix: prefix,
        input_micros_per_mtok: input.input_micros_per_mtok,
        output_micros_per_mtok: input.output_micros_per_mtok,
        cache_read_micros_per_mtok: input.cache_read_micros_per_mtok,
        cache_write_micros_per_mtok: input.cache_write_micros_per_mtok,
        tier_above_prompt_tokens: input.tier_above_prompt_tokens,
        tier_input_micros_per_mtok: input.tier_input_micros_per_mtok,
        tier_output_micros_per_mtok: input.tier_output_micros_per_mtok,
        tier_cache_read_micros_per_mtok: input.tier_cache_read_micros_per_mtok,
        tier_cache_write_micros_per_mtok: input.tier_cache_write_micros_per_mtok,
        source: input.source.trim().to_string(),
        as_of: input.as_of.trim().to_string(),
        updated_by_label: label.to_string(),
        updated_at: Some(Utc::now()),
    };
    let saved = if existing.is_some() {
        TaskflowModelPrice::objects().save(row).await.map_err(internal)?
    } else {
        TaskflowModelPrice::objects().create(row).await.map_err(internal)?
    };
    Ok(price_json(&saved))
}

/// Owners and admins (and superusers) manage prices and the budget.
pub async fn is_manager(user: i64, project: i64) -> bool {
    if taskflow_projects::scope::is_superuser(user).await {
        return true;
    }
    TaskflowProjectMember::objects()
        .filter(
            taskflow_project_member::PROJECT.eq(project)
                & taskflow_project_member::USER.eq(user)
                & taskflow_project_member::STATUS.eq("active"),
        )
        .first()
        .await
        .ok()
        .flatten()
        .is_some_and(|m| matches!(m.role, TaskflowProjectRole::Owner | TaskflowProjectRole::Admin))
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

fn dollars(micros: i64) -> String {
    format!("${:.2}", micros as f64 / MICROS as f64)
}

/// Record that an alert fired; false when it already had (fires once).
async fn first_time(project: i64, kind: &str, subject: &str) -> bool {
    TaskflowUsageAlert::objects()
        .create(TaskflowUsageAlert {
            id: 0,
            project: ForeignKey::new(project),
            kind: kind.to_string(),
            subject: subject.to_string(),
            created_at: None,
        })
        .await
        .is_ok()
}

async fn check_alerts(project: i64, report: &TaskflowUsageReport) {
    let Ok(s) = settings_for(project).await else { return };
    let now = Utc::now();

    // 1. Budget %: once per month, in the alert room.
    if let (Some(budget), Some(pct), Some(room)) = (s.budget_micros, s.alert_percent, s.alert_channel.as_ref().map(|c| c.id())) {
        let month_key = now.format("%Y-%m").to_string();
        if s.budget_alerted_month.as_deref() != Some(month_key.as_str()) && budget > 0 {
            let spend: i64 = reports_between(project, month_start(now), now + Duration::seconds(1))
                .await
                .unwrap_or_default()
                .iter()
                .filter_map(|r| r.cost_micros)
                .sum();
            if spend as i128 * 100 >= budget as i128 * pct as i128 {
                // Compare-and-set the month so two reports cannot both alert.
                let mut v = Map::new();
                v.insert("budget_alerted_month".into(), json!(month_key));
                let flipped = TaskflowUsageSettings::objects()
                    .filter(taskflow_usage_settings::ID.eq(s.id) & taskflow_usage_settings::BUDGET_ALERTED_MONTH.ne(month_key.as_str()))
                    .update_values(v.clone())
                    .await
                    .unwrap_or(0)
                    + if s.budget_alerted_month.is_none() {
                        TaskflowUsageSettings::objects()
                            .filter(taskflow_usage_settings::ID.eq(s.id) & taskflow_usage_settings::BUDGET_ALERTED_MONTH.is_null())
                            .update_values(v)
                            .await
                            .unwrap_or(0)
                    } else {
                        0
                    };
                if flipped > 0 {
                    let _ = taskflow_agents::wakeups::post_system_message(
                        project,
                        room,
                        None,
                        format!("[taskflow usage] This month's spend is {} of the {} budget ({pct}% alert). Self-reported by agents' MCPs.", dollars(spend), dollars(budget)),
                    )
                    .await;
                }
            }
        }
    }

    // 2. Task cap: "stop and ask" — a notice to the agent and a blocking decision.
    if let (Some(cap), Some(task)) = (s.task_cap_micros, report.task) {
        let spent: i64 = TaskflowUsageReport::objects()
            .filter(taskflow_usage_report::TASK.eq(task))
            .fetch()
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|r| r.cost_micros)
            .sum();
        if spent > cap && first_time(project, "task_cap", &format!("task:{task}")).await {
            let agent = report.agent.id();
            let _ = taskflow_agents::wakeups::notify_agent(
                agent,
                format!("[taskflow usage] #TSK{task} has passed its {} cap ({} so far). Stop and ask before continuing: a decision is open.", dollars(cap), dollars(spent)),
            )
            .await;
            let actor = taskflow_decisions::service::Actor::Agent { id: agent, label: "TaskFlow usage".to_string() };
            let _ = taskflow_decisions::service::ask(
                project,
                &actor,
                taskflow_decisions::service::AskInput {
                    key: format!("continue-task-{task}-over-budget"),
                    question: format!("#TSK{task} passed its {} cost cap. Continue?", dollars(cap)),
                    context_markdown: Some(format!("Spent so far: {} (self-reported).", dollars(spent))),
                    options: vec![
                        taskflow_decisions::service::OptionInput { label: "Continue".into(), detail: Some("Keep working on the task.".into()), recommended: false },
                        taskflow_decisions::service::OptionInput { label: "Stop".into(), detail: Some("Pause the task and report.".into()), recommended: false },
                    ],
                    ruler_user: None,
                    task_ids: vec![task],
                    channel: None,
                },
            )
            .await;
        }
    }

    // 3. Idle spend: no task in progress, ≥ $1 in the last hour, once per agent-hour.
    if s.idle_alert && report.task.is_none() {
        if let Some(room) = s.alert_channel.as_ref().map(|c| c.id()) {
            let agent = report.agent.id();
            let hour_ago = now - Duration::hours(1);
            let idle: i64 = TaskflowUsageReport::objects()
                .filter(taskflow_usage_report::AGENT.eq(agent) & taskflow_usage_report::REPORTED_AT.gte(hour_ago))
                .fetch()
                .await
                .unwrap_or_default()
                .iter()
                .filter(|r| r.task.is_none())
                .filter_map(|r| r.cost_micros)
                .sum();
            if idle >= MICROS && first_time(project, "idle", &format!("agent:{agent}:{}", now.format("%Y-%m-%dT%H"))).await {
                let _ = taskflow_agents::wakeups::post_system_message(
                    project,
                    room,
                    None,
                    format!("[taskflow usage] Agent {agent} spent {} in the last hour with no task in progress.", dollars(idle)),
                )
                .await;
            }
        }
    }
}
