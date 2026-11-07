//! #644: a message's structured question set.
//!
//! An agent that needs three decisions should not ask them as prose. A message
//! may carry a `questions` payload — radio, select, text and date inputs, with
//! an optional "other" on the pickers — which the chat renders as a form. The
//! answers ride back as an ORDINARY message (no new transport), so the agent
//! reads prose and the human gets a well-rendered dialog.
//!
//! The row stores the payload as a JSON STRING, the same shape `targets`
//! already uses; this module owns the schema and validates it on the send
//! paths, so a message whose form could not render is refused before it is
//! stored rather than shipped to every client.

use serde::{Deserialize, Serialize};

/// More questions than a person answers in one sitting; also the UI's layout
/// budget for the dialog.
pub const MAX_QUESTIONS: usize = 8;
/// Options per picker.
pub const MAX_OPTIONS: usize = 12;
/// The whole payload, matching the column's own ceiling (`models.rs`).
pub const MAX_BYTES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Radio,
    Select,
    Text,
    Date,
    /// #1099: a plain yes or no. No options; the answer is a bool.
    YesNo,
    /// #1099: checkboxes — pick any number of the options, within
    /// `min_select`..=`max_select`. The answer is an array of option values.
    Multi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub value: String,
    pub label: String,
    /// Optional supporting line under the option (rendered on the card).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    /// Stable identity for the answer ("scope: buttons"), unique in the set.
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: QuestionKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<QuestionOption>,
    /// Pickers only: offer an "Other…" text input beside the options.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allow_other: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    /// Text questions: the input's placeholder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Text questions: a taller box for prose answers.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub multiline: bool,
    /// Multi questions: the fewest options that may be picked (default 0, or
    /// 1 when `required`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_select: Option<usize>,
    /// Multi questions: the most options that may be picked (default: all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_select: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionSet {
    /// The dialog's heading ("Which direction should pricing take?").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub questions: Vec<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancel_label: Option<String>,
}

/// Parse and normalise a question set. `Ok(json)` is the canonical JSON to
/// store (unknown fields dropped, defaults made explicit); `Err` is the
/// sentence the caller turns into a 400.
pub fn validate(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_BYTES {
        return Err(format!("questions is {} bytes; the limit is {MAX_BYTES}", raw.len()));
    }
    let set: QuestionSet = serde_json::from_str(raw).map_err(|error| {
        // serde's own text names the offending field and the expected variants
        // ("unknown variant `checkbox`, expected one of `radio`, `select`…"),
        // which is exactly what an agent needs to fix the call.
        format!("questions is not a valid question set: {error}")
    })?;
    validate_set(&set)?;
    serde_json::to_string(&set).map_err(|_| "questions could not be stored".to_string())
}

fn validate_set(set: &QuestionSet) -> Result<(), String> {
    if set.questions.is_empty() {
        return Err("questions must hold at least one question".to_string());
    }
    if set.questions.len() > MAX_QUESTIONS {
        return Err(format!("{} questions; the limit is {MAX_QUESTIONS}", set.questions.len()));
    }
    if let Some(title) = &set.title {
        if title.chars().count() > 200 {
            return Err("the questions title is over 200 characters".to_string());
        }
    }
    let mut seen = std::collections::HashSet::new();
    for question in &set.questions {
        let key = question.key.trim();
        if key.is_empty() || key.len() > 40 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':') {
            return Err(format!(
                "question key `{}` must be 1-40 characters of letters, digits, `-`, `_` or `:`",
                question.key
            ));
        }
        if !seen.insert(key.to_string()) {
            return Err(format!("two questions share the key `{key}`"));
        }
        let label = question.label.trim();
        if label.is_empty() || label.chars().count() > 200 {
            return Err(format!("question `{key}` needs a label of 1-200 characters"));
        }
        match question.kind {
            QuestionKind::Radio | QuestionKind::Select | QuestionKind::Multi => {
                if question.kind == QuestionKind::Multi {
                    if question.allow_other {
                        return Err(format!("question `{key}`: `allow_other` is for radio and select"));
                    }
                    let n = question.options.len();
                    let min = question.min_select.unwrap_or(0);
                    let max = question.max_select.unwrap_or(n);
                    if max == 0 || max > n || min > max {
                        return Err(format!(
                            "question `{key}`: min_select/max_select must satisfy 0 <= min <= max <= {n} and max >= 1"
                        ));
                    }
                } else if question.min_select.is_some() || question.max_select.is_some() {
                    return Err(format!("question `{key}`: min_select/max_select are for multi questions"));
                }
                if question.options.len() < 2 {
                    return Err(format!("question `{key}` is a picker, so it needs at least 2 options"));
                }
                if question.options.len() > MAX_OPTIONS {
                    return Err(format!("question `{key}` has {} options; the limit is {MAX_OPTIONS}", question.options.len()));
                }
                let mut values = std::collections::HashSet::new();
                for option in &question.options {
                    if option.value.trim().is_empty() || option.value.chars().count() > 100 {
                        return Err(format!("question `{key}`: every option needs a value of 1-100 characters"));
                    }
                    if !values.insert(option.value.trim()) {
                        return Err(format!("question `{key}`: two options share the value `{}`", option.value));
                    }
                    if option.label.trim().is_empty() || option.label.chars().count() > 120 {
                        return Err(format!("question `{key}`: every option needs a label of 1-120 characters"));
                    }
                    if option.description.as_deref().is_some_and(|d| d.chars().count() > 300) {
                        return Err(format!("question `{key}`: an option description is over 300 characters"));
                    }
                }
            }
            QuestionKind::Text | QuestionKind::Date | QuestionKind::YesNo => {
                if question.min_select.is_some() || question.max_select.is_some() {
                    return Err(format!("question `{key}`: min_select/max_select are for multi questions"));
                }
                if !question.options.is_empty() {
                    return Err(format!("question `{key}` is a {} question and takes no options", kind_name(&question.kind)));
                }
                if question.allow_other {
                    return Err(format!("question `{key}`: `allow_other` is for pickers (radio, select)"));
                }
                if question.placeholder.as_deref().is_some_and(|p| p.chars().count() > 120) {
                    return Err(format!("question `{key}`: the placeholder is over 120 characters"));
                }
            }
        }
    }
    Ok(())
}

fn kind_name(kind: &QuestionKind) -> &'static str {
    match kind {
        QuestionKind::Radio => "radio",
        QuestionKind::Select => "select",
        QuestionKind::Text => "text",
        QuestionKind::Date => "date",
        QuestionKind::YesNo => "yes_no",
        QuestionKind::Multi => "multi",
    }
}

/// Parse a question set that is already stored (it was validated on send).
pub fn parse_stored(raw: &str) -> Option<QuestionSet> {
    serde_json::from_str(raw).ok()
}

/// Max characters of a free-text answer (text, or a picker's "other").
pub const MAX_ANSWER_CHARS: usize = 4000;

/// Check one answer against its question and return the canonical value to
/// store. `Err` is a sentence naming what is wrong, for a field-level 400.
pub fn check_answer(question: &Question, value: &serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let key = &question.key;
    let text = |v: &Value| -> Result<String, String> {
        let s = v.as_str().ok_or_else(|| format!("`{key}` takes a string"))?.trim().to_string();
        if s.is_empty() {
            return Err(format!("`{key}` cannot be empty"));
        }
        if s.chars().count() > MAX_ANSWER_CHARS {
            return Err(format!("`{key}` is over {MAX_ANSWER_CHARS} characters"));
        }
        Ok(s)
    };
    match question.kind {
        QuestionKind::YesNo => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| format!("`{key}` is yes/no: answer true or false")),
        QuestionKind::Radio | QuestionKind::Select => {
            let s = text(value)?;
            if question.options.iter().any(|o| o.value == s) || question.allow_other {
                Ok(Value::String(s))
            } else {
                Err(format!("`{key}`: `{s}` is not one of its options"))
            }
        }
        QuestionKind::Multi => {
            let items = value.as_array().ok_or_else(|| format!("`{key}` is multi: answer an array of option values"))?;
            let mut picked: Vec<String> = Vec::new();
            for item in items {
                let s = item.as_str().ok_or_else(|| format!("`{key}`: every pick is an option value string"))?;
                if !question.options.iter().any(|o| o.value == s) {
                    return Err(format!("`{key}`: `{s}` is not one of its options"));
                }
                if !picked.iter().any(|p| p == s) {
                    picked.push(s.to_string());
                }
            }
            let min = question.min_select.unwrap_or(usize::from(question.required));
            let max = question.max_select.unwrap_or(question.options.len());
            if picked.len() < min || picked.len() > max {
                return Err(format!("`{key}`: pick between {min} and {max} options"));
            }
            Ok(Value::Array(picked.into_iter().map(Value::String).collect()))
        }
        QuestionKind::Text => text(value).map(Value::String),
        QuestionKind::Date => {
            let s = text(value)?;
            chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                .map_err(|_| format!("`{key}` is a date: answer YYYY-MM-DD"))?;
            Ok(Value::String(s))
        }
    }
}

/// How an answer reads in the auto-reply: option LABELS, not raw values, and
/// yes/no as words — the same `- label (key): answer` line the popup form sent.
pub fn display_answer(question: &Question, value: &serde_json::Value) -> String {
    let label_of = |v: &str| {
        question
            .options
            .iter()
            .find(|o| o.value == v)
            .map(|o| o.label.clone())
            .unwrap_or_else(|| v.to_string())
    };
    match value {
        serde_json::Value::Bool(true) => "Yes".to_string(),
        serde_json::Value::Bool(false) => "No".to_string(),
        serde_json::Value::String(s) => label_of(s),
        serde_json::Value::Array(items) => {
            let picked: Vec<String> = items.iter().filter_map(|v| v.as_str()).map(label_of).collect();
            if picked.is_empty() { "(none)".to_string() } else { picked.join(", ") }
        }
        other => other.to_string(),
    }
}
