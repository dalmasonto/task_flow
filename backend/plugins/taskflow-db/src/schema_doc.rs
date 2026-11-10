//! The schema document (#885): the data model of the project being built, as
//! agents and the human write it. Pure — no I/O — so every rule here is unit
//! tested: validation, who-wrote-what, and the lock that keeps an agent from
//! silently undoing a human's edit.
//!
//! The document is one JSON value per project:
//! `{ "models": [ { "name", "group", "fields": [...], "samples": [...] } ] }`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Field types a model may use. `enum` needs `values`; `fk` needs `fk`.
pub const FIELD_TYPES: &[&str] = &[
    "String", "Text", "i64", "f64", "bool", "Date", "DateTime", "Json", "Uuid", "enum", "fk",
];

pub const MAX_MODELS: usize = 200;
pub const MAX_FIELDS: usize = 120;
pub const MAX_SAMPLES: usize = 50;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SchemaDoc {
    #[serde(default)]
    pub models: Vec<Model>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Model {
    pub name: String,
    /// A free label used to colour and cluster the diagram (an app, a plugin).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default)]
    pub fields: Vec<Field>,
    /// Sample or seed rows for the Data tab: field name -> value.
    #[serde(default)]
    pub samples: Vec<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(default)]
    pub optional: bool,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub indexed: bool,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// The allowed values of an `enum` field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fk: Option<ForeignKeyDef>,
    /// Who last changed this field's definition. Set by the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by: Option<Author>,
    /// A human changed this field; an agent may not change or remove it
    /// without `override`. Set by the server.
    #[serde(default)]
    pub locked_by_user: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForeignKeyDef {
    pub model: String,
    /// `cascade` | `set_null` | `restrict`.
    #[serde(default = "default_on_delete")]
    pub on_delete: String,
}

fn default_on_delete() -> String {
    "cascade".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Author {
    /// `user` | `agent`.
    pub kind: String,
    pub id: i64,
    pub label: String,
}

impl Author {
    pub fn user(id: i64, label: &str) -> Self {
        Author { kind: "user".into(), id, label: label.into() }
    }
    pub fn agent(id: i64, label: &str) -> Self {
        Author { kind: "agent".into(), id, label: label.into() }
    }
}

impl Field {
    /// The definition without the server-kept metadata: what "changed" means.
    fn definition(&self) -> Field {
        Field { written_by: None, locked_by_user: false, ..self.clone() }
    }
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && s.len() <= 64
}

/// Every problem in the document, each naming where it is, so a refusal tells
/// the writer exactly what to fix. Empty means valid.
pub fn validate(doc: &SchemaDoc) -> Vec<String> {
    let mut errors = Vec::new();
    if doc.models.len() > MAX_MODELS {
        errors.push(format!("too many models ({} > {MAX_MODELS})", doc.models.len()));
    }
    let names: BTreeSet<&str> = doc.models.iter().map(|m| m.name.as_str()).collect();
    let mut seen = BTreeSet::new();
    for model in &doc.models {
        let m = &model.name;
        if !is_identifier(m) {
            errors.push(format!("model `{m}`: the name must be an identifier (letters, digits, _)"));
        }
        if !seen.insert(m.as_str()) {
            errors.push(format!("model `{m}` appears twice"));
        }
        if model.fields.len() > MAX_FIELDS {
            errors.push(format!("model `{m}`: too many fields ({} > {MAX_FIELDS})", model.fields.len()));
        }
        if model.samples.len() > MAX_SAMPLES {
            errors.push(format!("model `{m}`: too many sample rows ({} > {MAX_SAMPLES})", model.samples.len()));
        }
        let mut field_names = BTreeSet::new();
        for f in &model.fields {
            let at = format!("{m}.{}", f.name);
            if !is_identifier(&f.name) {
                errors.push(format!("`{at}`: the field name must be an identifier"));
            }
            if !field_names.insert(f.name.as_str()) {
                errors.push(format!("`{at}` appears twice"));
            }
            if !FIELD_TYPES.contains(&f.ty.as_str()) {
                errors.push(format!("`{at}`: unknown type `{}` (one of {})", f.ty, FIELD_TYPES.join(", ")));
            }
            if f.ty == "enum" && f.values.is_empty() {
                errors.push(format!("`{at}`: an enum needs at least one value"));
            }
            match (&f.fk, f.ty.as_str()) {
                (None, "fk") => errors.push(format!("`{at}`: an fk field needs `fk.model`")),
                (Some(fk), _) if !names.contains(fk.model.as_str()) => {
                    errors.push(format!("`{at}`: points at `{}`, which is not a model here", fk.model))
                }
                (Some(fk), _) if !["cascade", "set_null", "restrict"].contains(&fk.on_delete.as_str()) => {
                    errors.push(format!("`{at}`: on_delete must be cascade, set_null or restrict"))
                }
                (Some(_), "set_null") => {}
                _ => {}
            }
            if f.fk.as_ref().is_some_and(|fk| fk.on_delete == "set_null") && !f.optional {
                errors.push(format!("`{at}`: on_delete set_null needs the field to be optional"));
            }
        }
        for (i, row) in model.samples.iter().enumerate() {
            for key in row.keys() {
                if !field_names.contains(key.as_str()) {
                    errors.push(format!("model `{m}` sample {}: `{key}` is not a field", i + 1));
                }
            }
        }
    }
    errors
}

/// Apply a HUMAN's whole-document save. Every field that is new or whose
/// definition differs from `prev` becomes written by `who` and locked; every
/// unchanged field keeps the metadata it had (so an agent's field the human did
/// not touch stays the agent's and unlocked).
pub fn apply_human_save(prev: &SchemaDoc, mut next: SchemaDoc, who: &Author) -> SchemaDoc {
    for model in &mut next.models {
        let before = prev.models.iter().find(|m| m.name == model.name);
        for field in &mut model.fields {
            let old = before.and_then(|m| m.fields.iter().find(|f| f.name == field.name));
            match old {
                Some(old) if old.definition() == field.definition() => {
                    field.written_by = old.written_by.clone();
                    field.locked_by_user = old.locked_by_user;
                }
                _ => {
                    field.written_by = Some(who.clone());
                    field.locked_by_user = true;
                }
            }
        }
    }
    next
}

/// Why an agent's write was refused: the locked fields it would change or drop.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LockConflict {
    pub model: String,
    pub fields: Vec<String>,
}

/// Apply an AGENT's write of one model (create or replace). Locked fields the
/// write would change or remove are refused unless `override_locks`. The fields
/// the agent changes become written by it and unlocked; unchanged fields keep
/// their metadata. Sample rows are taken as sent.
pub fn apply_agent_model(
    doc: &SchemaDoc,
    mut model: Model,
    who: &Author,
    override_locks: bool,
) -> Result<SchemaDoc, LockConflict> {
    let before = doc.models.iter().find(|m| m.name == model.name);
    if let Some(before) = before {
        let mut blocked = Vec::new();
        for old in before.fields.iter().filter(|f| f.locked_by_user) {
            match model.fields.iter().find(|f| f.name == old.name) {
                Some(new) if new.definition() == old.definition() => {}
                _ => blocked.push(old.name.clone()),
            }
        }
        if !blocked.is_empty() && !override_locks {
            return Err(LockConflict { model: model.name.clone(), fields: blocked });
        }
    }
    for field in &mut model.fields {
        let old = before.and_then(|m| m.fields.iter().find(|f| f.name == field.name));
        match old {
            Some(old) if old.definition() == field.definition() => {
                field.written_by = old.written_by.clone();
                field.locked_by_user = old.locked_by_user;
            }
            _ => {
                field.written_by = Some(who.clone());
                field.locked_by_user = false;
            }
        }
    }
    let mut next = doc.clone();
    match next.models.iter_mut().find(|m| m.name == model.name) {
        Some(slot) => *slot = model,
        None => next.models.push(model),
    }
    Ok(next)
}

/// Remove a model as an AGENT: refused while it holds locked fields, unless
/// `override_locks`. Returns `None` when there is no such model.
pub fn delete_model_as_agent(
    doc: &SchemaDoc,
    name: &str,
    override_locks: bool,
) -> Option<Result<SchemaDoc, LockConflict>> {
    let model = doc.models.iter().find(|m| m.name == name)?;
    let locked: Vec<String> = model.fields.iter().filter(|f| f.locked_by_user).map(|f| f.name.clone()).collect();
    if !locked.is_empty() && !override_locks {
        return Some(Err(LockConflict { model: name.to_string(), fields: locked }));
    }
    let mut next = doc.clone();
    next.models.retain(|m| m.name != name);
    Some(Ok(next))
}

/// Models that point at `name` through an fk — the "has many" side of the
/// diagram, and what deleting `name` would break.
pub fn referrers<'a>(doc: &'a SchemaDoc, name: &str) -> Vec<(&'a str, &'a str)> {
    doc.models
        .iter()
        .flat_map(|m| {
            m.fields
                .iter()
                .filter(move |f| f.fk.as_ref().is_some_and(|fk| fk.model == name))
                .map(move |f| (m.name.as_str(), f.name.as_str()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(name: &str, ty: &str) -> Field {
        Field { name: name.into(), ty: ty.into(), ..Field::default() }
    }

    fn doc() -> SchemaDoc {
        SchemaDoc {
            models: vec![
                Model {
                    name: "Agent".into(),
                    group: Some("agents".into()),
                    fields: vec![
                        Field { primary_key: true, ..field("id", "i64") },
                        Field {
                            fk: Some(ForeignKeyDef { model: "Project".into(), on_delete: "cascade".into() }),
                            ..field("project", "fk")
                        },
                        field("display_name", "String"),
                    ],
                    samples: vec![],
                },
                Model { name: "Project".into(), fields: vec![field("id", "i64")], ..Model::default() },
            ],
        }
    }

    #[test]
    fn a_valid_document_has_no_errors() {
        assert!(validate(&doc()).is_empty(), "{:?}", validate(&doc()));
    }

    #[test]
    fn validation_names_each_problem() {
        let mut d = doc();
        d.models[0].fields.push(field("display_name", "String"));
        d.models[0].fields.push(field("kind", "enum"));
        d.models[0].fields.push(Field {
            fk: Some(ForeignKeyDef { model: "Nope".into(), on_delete: "cascade".into() }),
            ..field("owner", "fk")
        });
        d.models[0].fields.push(field("bad name", "Strng"));
        let errors = validate(&d);
        assert!(errors.iter().any(|e| e.contains("Agent.display_name") && e.contains("twice")));
        assert!(errors.iter().any(|e| e.contains("Agent.kind") && e.contains("enum")));
        assert!(errors.iter().any(|e| e.contains("Agent.owner") && e.contains("Nope")));
        assert!(errors.iter().any(|e| e.contains("unknown type `Strng`")));
    }

    #[test]
    fn set_null_needs_an_optional_field() {
        let mut d = doc();
        d.models[0].fields[1].fk.as_mut().unwrap().on_delete = "set_null".into();
        assert!(validate(&d).iter().any(|e| e.contains("set_null")));
        d.models[0].fields[1].optional = true;
        assert!(validate(&d).is_empty());
    }

    #[test]
    fn a_human_edit_locks_only_what_it_changed() {
        let agent = Author::agent(1, "Claude (main)");
        let human = Author::user(9, "dalmasonto");
        let prev = apply_agent_model(&SchemaDoc::default(), doc().models[0].clone(), &agent, false).unwrap();
        let mut next = prev.clone();
        next.models[0].fields[2].unique = true; // display_name changed
        let saved = apply_human_save(&prev, next, &human);
        let f = &saved.models[0].fields;
        assert!(f[2].locked_by_user);
        assert_eq!(f[2].written_by.as_ref().unwrap().kind, "user");
        assert!(!f[0].locked_by_user, "untouched fields stay the agent's");
        assert_eq!(f[0].written_by.as_ref().unwrap().kind, "agent");
    }

    #[test]
    fn an_agent_cannot_change_or_drop_a_locked_field_without_override() {
        let agent = Author::agent(1, "Claude (main)");
        let human = Author::user(9, "dalmasonto");
        let base = apply_agent_model(&SchemaDoc::default(), doc().models[0].clone(), &agent, false).unwrap();
        let mut edited = base.clone();
        edited.models[0].fields[2].unique = true;
        let locked = apply_human_save(&base, edited, &human);

        // Changing it is refused, naming the field.
        let mut attempt = locked.models[0].clone();
        attempt.fields[2].unique = false;
        let err = apply_agent_model(&locked, attempt.clone(), &agent, false).unwrap_err();
        assert_eq!(err, LockConflict { model: "Agent".into(), fields: vec!["display_name".into()] });

        // Dropping it is refused too.
        let mut dropped = locked.models[0].clone();
        dropped.fields.retain(|f| f.name != "display_name");
        assert!(apply_agent_model(&locked, dropped, &agent, false).is_err());

        // Untouched locked field + a new field: allowed, and the lock survives.
        let mut extend = locked.models[0].clone();
        extend.fields.push(field("status", "String"));
        let ok = apply_agent_model(&locked, extend, &agent, false).unwrap();
        let f = &ok.models[0].fields;
        assert!(f.iter().find(|f| f.name == "display_name").unwrap().locked_by_user);
        assert_eq!(f.iter().find(|f| f.name == "status").unwrap().written_by.as_ref().unwrap().kind, "agent");

        // With override, the change goes in and the field becomes the agent's.
        let forced = apply_agent_model(&locked, attempt, &agent, true).unwrap();
        let dn = forced.models[0].fields.iter().find(|f| f.name == "display_name").unwrap();
        assert!(!dn.locked_by_user);
        assert_eq!(dn.written_by.as_ref().unwrap().kind, "agent");
    }

    #[test]
    fn an_agent_cannot_delete_a_model_holding_locked_fields() {
        let human = Author::user(9, "dalmasonto");
        let mut edited = doc();
        edited.models[0].fields[2].unique = true;
        let locked = apply_human_save(&doc(), edited, &human);
        assert!(delete_model_as_agent(&locked, "Agent", false).unwrap().is_err());
        assert!(delete_model_as_agent(&locked, "Agent", true).unwrap().is_ok());
        assert!(delete_model_as_agent(&locked, "Missing", false).is_none());
    }

    #[test]
    fn referrers_lists_the_models_pointing_at_one() {
        assert_eq!(referrers(&doc(), "Project"), vec![("Agent", "project")]);
    }

    #[test]
    fn the_wire_shape_round_trips() {
        let json = serde_json::json!({
            "models": [{ "name": "Task", "fields": [
                { "name": "id", "type": "i64", "primary_key": true },
                { "name": "status", "type": "enum", "values": ["todo", "done"] }
            ], "samples": [{ "id": 1, "status": "todo" }] }]
        });
        let d: SchemaDoc = serde_json::from_value(json).unwrap();
        assert!(validate(&d).is_empty());
        assert_eq!(d.models[0].fields[1].values, vec!["todo", "done"]);
    }
}
