//! Declared-length enforcement for model writes — the app-side stopgap for a
//! framework gap.
//!
//! ## The bug this exists for
//!
//! `#[umbral(string, max_length = N)]` is the attribute that makes the migration
//! engine emit `varchar(N)` — a HARD database constraint. But **no ORM write
//! path validates against it**. `FieldSpec::max_length` is read by the DDL pass
//! and by the admin's display truncation, and by `umbral::validate` for DTOs —
//! but `validate_on_create` checks required / choices / M2M / FK only, and
//! `WriteError` has no length variant at all.
//!
//! So an over-long value travels all the way to Postgres, which raises SQLSTATE
//! 22001. `From<sqlx::Error> for ApiError` maps only `sqlx::Error::Protocol` to
//! a 400, so everything else lands on the `ApiError::Sqlx` arm — a **500** whose
//! text is deliberately hidden from the client (WEB-5). The caller gets an
//! opaque "internal server error" for a mistake the request body itself made.
//!
//! Observed in production: pasting a 12,617-character markdown file into a task
//! description (`varchar(12000)`) 500'd `POST /api/taskflow_task/` three times
//! in a row. The failing value was 617 characters over.
//!
//! ## Why a cleaner, and not a framework edit
//!
//! `umbral::orm::cleaners` is the framework's public extension point for
//! per-field write rules, and `cleaners::apply` is called from
//! `build_insert_plan` — the seam every dynamic/REST insert passes through — as
//! well as the typed insert and bulk paths. A cleaner returning
//! `Err(message)` becomes a `WriteError::Validator`, which umbral-rest already
//! renders as a **400 with a per-field error map**. No framework edit, no
//! handler wrapper, and the identical error shape `umbral::validate` produces
//! for DTOs — one API, one error format.
//!
//! The real fix belongs in the ORM's pre-DB validation; that is filed upstream
//! as **gaps6 #22** (`max_length` enforced nowhere). When it lands, delete this
//! module and its `install()` call.
//!
//! ## Three things worth knowing before you edit this
//!
//! **It does not cover typed `update_values`.** `cleaners::apply` is called from
//! the dynamic insert/update paths and the typed insert and bulk paths — but
//! *not* from `QuerySet::build_update_for`, which builds typed UPDATEs. So this
//! rule fires for every REST write and for `create`, and is **skipped** by the
//! ~a dozen `.update_values(..)` call sites in our own plugins
//! (`taskflow-agents/src/views.rs`, `taskflow-design/src/store.rs`,
//! `taskflow-projects/src/views.rs`, `taskflow-github/src/views.rs`). A capped
//! column written through one of those still reaches Postgres unvalidated and
//! still 500s. That hole is upstream **gaps6 #23**, not something this module
//! can close — do not read a green REST test as coverage for those paths.
//!
//! **SQLite does not enforce `varchar(N)`.** It is a type affinity, not a
//! constraint. So this bug is invisible in the test suite and in local dev, and
//! only bites on Postgres. The regression test therefore asserts the *pre-DB*
//! rejection (which SQLite cannot fake) rather than reproducing the 500.
//!
//! **The cap comes from the metadata, never a literal.** [`install`] reads
//! `max_length` off each model's `FIELDS` — the same slice the migration engine
//! reads to emit the DDL. A hand-copied `12000` would drift from the column it
//! guards the first time someone widens a field, which is exactly the class of
//! bug being fixed here.

use std::sync::Once;

use serde_json::Value as JsonValue;
use umbral::cleaners::register_cleaner;
use umbral::orm::Model;

/// Register the declared-length rule for every capped field on every model the
/// app lets a client write through.
///
/// The list is deliberately the *models*, not the *capped models*: registering
/// a model with no capped fields is free, because [`register_model`] skips
/// `max_length == 0`. Adding a `max_length` to any model below is enforced
/// without touching this function.
///
/// Idempotent. The cleaner registry is process-global and appends, so a second
/// call would stack a duplicate rule on every field; `boot()` is a `OnceCell`
/// and a test binary shares one process, so this is guarded rather than assumed.
///
/// Call it at boot, before the app serves. A mistake here is a programming
/// error and should be loud — `register_cleaner` panics if a field name does
/// not exist on its model.
pub fn install() {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        use taskflow_agents::models as agents;
        use taskflow_design::models as design;
        use taskflow_projects::models as projects;
        use taskflow_tasks::models as tasks;

        register_model::<agents::TaskflowAgent>();
        register_model::<agents::TaskflowAgentCredential>();
        register_model::<agents::TaskflowAgentSession>();
        register_model::<agents::TaskflowAgentChannel>();
        register_model::<agents::TaskflowAgentChannelMember>();
        register_model::<agents::TaskflowAgentMessage>();
        register_model::<agents::TaskflowMessageAttachment>();
        register_model::<agents::TaskflowChannelReadCursor>();
        register_model::<agents::TaskflowAgentTerminalFrame>();
        register_model::<agents::TaskflowAgentPrompt>();
        register_model::<agents::TaskflowTaskReview>();
        register_model::<agents::TaskflowTerminalInput>();
        register_model::<agents::TaskflowRealtimeTicket>();

        register_model::<design::DesignFile>();
        register_model::<design::DesignComment>();
        register_model::<design::DesignLayout>();

        register_model::<projects::TaskflowProject>();
        register_model::<projects::TaskflowProjectMember>();
        register_model::<projects::TaskflowProjectInvite>();
        register_model::<projects::TaskflowProjectApiEndpoint>();
        register_model::<projects::TaskflowUserSettings>();

        register_model::<tasks::TaskflowTask>();
        register_model::<tasks::TaskflowTaskRelation>();
        register_model::<tasks::TaskflowTaskActivity>();
        register_model::<tasks::TaskflowTaskSession>();
        register_model::<tasks::TaskflowTaskAttachment>();
    });
}

/// Register [`check_declared_length`] for each capped field of `M`.
///
/// A `max_length` of `0` means "no declared cap" — the same convention the
/// admin's display truncation uses — so uncapped fields cost nothing here.
fn register_model<M: Model>() {
    for field in M::FIELDS {
        if field.max_length == 0 {
            continue;
        }
        let cap = field.max_length as usize;
        let name = field.name;
        register_cleaner::<M>(name, move |value| {
            check_declared_length(name, value, cap)
        });
    }
}

/// Reject a string longer than the column's declared `max_length`.
///
/// Runs at the write seam, before the value is bound — so the database never
/// sees it and the client gets a 400 naming the field, its limit, and how far
/// over it went, instead of an opaque 500.
///
/// The message is deliberately the same wording `umbral::validate::check_max_length`
/// already produces for DTOs, so a model write and a DTO write report a
/// too-long value identically.
///
/// ## Two constraints that are easy to get wrong
///
/// **Characters, not bytes.** `varchar(N)` counts characters, and so does
/// `umbral::validate`. `str::len()` would be wrong twice over: it counts bytes,
/// so it would reject a perfectly legal name made of accented letters — data
/// loss in the shape of a validation error. `chars().count()` is the count
/// Postgres uses.
///
/// **`0` means "no declared cap"**, matching what the admin's display
/// truncation does with the same field. Note the check is only reached for
/// capped fields anyway — [`register_model`] skips the rest — but the guard
/// keeps the rule honest if it is ever called directly.
///
/// A non-string value is left alone: `max_length` says nothing about an integer,
/// and a type mismatch is `json_to_sea_value`'s job to report, later and more
/// precisely.
fn check_declared_length(_field: &str, value: &JsonValue, cap: usize) -> Result<JsonValue, String> {
    if cap == 0 {
        return Ok(value.clone());
    }
    let Some(text) = value.as_str() else {
        return Ok(value.clone());
    };
    let len = text.chars().count();
    if len > cap {
        return Err(format!("Must be at most {cap} characters (got {len})."));
    }
    Ok(value.clone())
}
