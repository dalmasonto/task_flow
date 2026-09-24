//! The design-layout document: which arrangement the canvas uses, the canonical
//! page order, and the named page groups.
//!
//! One JSON document per project, for the same reason `styles/tokens.json` is
//! one document: order IS the content here, so normalising groups into rows
//! would buy nothing and cost an ordering column.
//!
//! Two directions, deliberately asymmetric (spec §A):
//!   * `validate` is STRICT — a caller sending a route we cannot render is
//!     told so, rather than silently storing a board that will never be drawn.
//!   * `filter_to_known` is FORGIVING — a stored document outlives the pages it
//!     names, and refusing to serve it would wedge the client against a
//!     document it has no way to repair.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::models::DesignView;

pub const MAX_GROUPS: usize = 24;
pub const MAX_GROUP_NAME: usize = 40;
const MAX_GROUP_ID: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LayoutGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub routes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutDoc {
    #[serde(default)]
    pub view: DesignView,
    #[serde(default)]
    pub route_order: Vec<String>,
    #[serde(default)]
    pub groups: Vec<LayoutGroup>,
}

/// What a project has before anyone has arranged anything: today's view, every
/// page in manifest order, nothing grouped.
pub fn default_doc() -> LayoutDoc {
    LayoutDoc { view: DesignView::Rows, route_order: Vec::new(), groups: Vec::new() }
}

/// Tolerant on shape, strict on syntax. A caller that cannot parse falls back to
/// `default_doc()` rather than erroring the read.
pub fn parse(raw: &str) -> Result<LayoutDoc, String> {
    serde_json::from_str::<LayoutDoc>(raw).map_err(|e| format!("invalid layout document: {e}"))
}

pub fn to_json_string(doc: &LayoutDoc) -> String {
    // Serialising our own plain struct cannot fail; a panic here would be a bug
    // in this module, not bad input.
    serde_json::to_string(doc).expect("LayoutDoc serialises")
}

pub fn to_value(doc: &LayoutDoc) -> serde_json::Value {
    serde_json::to_value(doc).expect("LayoutDoc serialises")
}

/// Strict: everything a client sends must be renderable against the live
/// manifest. Names are trimmed and the document comes back normalised, so what
/// is stored is exactly what a later read will parse.
pub fn validate(doc: LayoutDoc, known_routes: &[String]) -> Result<LayoutDoc, String> {
    if doc.groups.len() > MAX_GROUPS {
        return Err(format!("at most {MAX_GROUPS} pages groups are allowed"));
    }
    let known: HashSet<&str> = known_routes.iter().map(String::as_str).collect();

    let mut seen_names: HashSet<String> = HashSet::new();
    let mut claimed: HashSet<String> = HashSet::new();
    let mut groups = Vec::with_capacity(doc.groups.len());

    for group in doc.groups {
        let name = group.name.trim().to_string();
        if name.is_empty() {
            return Err("a group name cannot be empty".into());
        }
        if name.chars().count() > MAX_GROUP_NAME {
            return Err(format!("a group name is limited to {MAX_GROUP_NAME} characters"));
        }
        if !seen_names.insert(name.to_lowercase()) {
            return Err(format!("the group name \"{name}\" is already used"));
        }
        let id = group.id.trim().to_string();
        if id.is_empty() || id.chars().count() > MAX_GROUP_ID {
            return Err("a group needs a non-empty id of at most 64 characters".into());
        }

        let mut routes = Vec::with_capacity(group.routes.len());
        for route in group.routes {
            if !known.contains(route.as_str()) {
                return Err(format!("\"{route}\" is not a page in this project"));
            }
            if !claimed.insert(route.clone()) {
                return Err(format!("\"{route}\" is already in another group"));
            }
            routes.push(route);
        }
        groups.push(LayoutGroup { id, name, routes });
    }

    // Order is advisory but still names pages, so unknown entries are refused
    // for the same reason as group routes: a client sending one is stale.
    let mut route_order = Vec::with_capacity(doc.route_order.len());
    let mut seen_order: HashSet<String> = HashSet::new();
    for route in doc.route_order {
        if !known.contains(route.as_str()) {
            return Err(format!("\"{route}\" is not a page in this project"));
        }
        if seen_order.insert(route.clone()) {
            route_order.push(route);
        }
    }

    Ok(LayoutDoc { view: doc.view, route_order, groups })
}

/// Forgiving read path: drop routes the manifest no longer has, keep the group
/// (a grouping is a decision about the project, and one deleted page is not
/// grounds to throw it away).
pub fn filter_to_known(doc: LayoutDoc, known_routes: &[String]) -> LayoutDoc {
    let known: HashSet<&str> = known_routes.iter().map(String::as_str).collect();
    LayoutDoc {
        view: doc.view,
        route_order: doc
            .route_order
            .into_iter()
            .filter(|r| known.contains(r.as_str()))
            .collect(),
        groups: doc
            .groups
            .into_iter()
            .map(|g| LayoutGroup {
                routes: g.routes.into_iter().filter(|r| known.contains(r.as_str())).collect(),
                ..g
            })
            .collect(),
    }
}
