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

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::models::DesignView;

pub const MAX_GROUPS: usize = 24;
pub const MAX_GROUP_NAME: usize = 40;
pub const MAX_LABEL: usize = 40;
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
    /// Display labels, route → human name. A *label* only: the page's own title
    /// and the real app are untouched. Absent for a route that has never been
    /// renamed, which is why every reader must fall back to the manifest title.
    #[serde(default)]
    pub page_labels: HashMap<String, String>,
}

/// What a project has before anyone has arranged anything: today's view, every
/// page in manifest order, nothing grouped.
pub fn default_doc() -> LayoutDoc {
    LayoutDoc {
        view: DesignView::Rows,
        route_order: Vec::new(),
        groups: Vec::new(),
        page_labels: HashMap::new(),
    }
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

    // Same rule as group routes: a label names a page, so a stale client
    // sending one for a route that does not exist is refused rather than stored.
    let mut page_labels = HashMap::with_capacity(doc.page_labels.len());
    for (route, label) in doc.page_labels {
        if !known.contains(route.as_str()) {
            return Err(format!("\"{route}\" is not a page in this project"));
        }
        let label = label.trim().to_string();
        if label.is_empty() {
            return Err(format!("the label for \"{route}\" cannot be empty"));
        }
        if label.chars().count() > MAX_LABEL {
            return Err(format!("a page label is limited to {MAX_LABEL} characters"));
        }
        page_labels.insert(route, label);
    }

    Ok(LayoutDoc { view: doc.view, route_order, groups, page_labels })
}

/// The presentation order — the FLOW — resolved over the pages the project
/// actually has: the stored `route_order` first, then every route it does not
/// name, appended in the order `known_routes` arrives in.
///
/// The mirror of the client's `resolveRouteOrder`
/// (`v2_fe/src/lib/design-layout.ts`), and the reason a read can answer at all:
/// the stored order is SPARSE. A page added after the document was written is
/// not in it, and `filter_to_known` has just dropped the pages that are gone,
/// so the stored list on its own is not an arrangement. Total and lossless: the
/// result is a permutation of `known_routes`, so every page has exactly one
/// position and none has two.
///
/// Repeats are dropped FIRST-WINS, the rule `validate` stores by
/// (`seen_order`), so a hand-edited document naming a page twice still lists it
/// once — and the unknown-route filter is repeated here rather than assumed,
/// because this is also called on a document that has not been through
/// `filter_to_known`.
pub fn resolve_route_order(doc: &LayoutDoc, known_routes: &[String]) -> Vec<String> {
    let known: HashSet<&str> = known_routes.iter().map(String::as_str).collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut flow: Vec<String> = Vec::with_capacity(known_routes.len());
    for route in &doc.route_order {
        if !known.contains(route.as_str()) || !seen.insert(route.as_str()) {
            continue;
        }
        flow.push(route.clone());
    }
    for route in known_routes {
        if !seen.contains(route.as_str()) {
            flow.push(route.clone());
        }
    }
    flow
}

/// The Pages panel's two halves, as `groupedPages` builds them
/// (`v2_fe/src/pages/design/pages-order.ts`): each group with the pages it
/// claims, then the pages no listed group claims. Both lists are in flow order.
///
/// Three rules, all of them the panel's, and each one is the answer to a
/// question the raw document does not answer:
///  * a group's pages are read in RESOLVED-flow order, never in the order the
///    group's own `routes` array happens to hold — that array is assignment
///    order (`assignRoute` appends), which is not an arrangement;
///  * a route two groups both claim lists under the FIRST of them, which is what
///    makes the two halves a PARTITION of `known_routes`: every page is listed
///    exactly once, and no page is listed twice;
///  * an empty group keeps its section — `createGroup` makes one, the panel
///    draws it with its move arrows, so dropping it here would report an
///    arrangement the operator is not looking at.
pub fn panel_sections(doc: &LayoutDoc, known_routes: &[String]) -> (Vec<LayoutGroup>, Vec<String>) {
    let flow = resolve_route_order(doc, known_routes);
    let mut claimed: HashSet<&str> = HashSet::new();
    let mut groups = Vec::with_capacity(doc.groups.len());
    for group in &doc.groups {
        let mut routes = Vec::new();
        for route in &flow {
            if claimed.contains(route.as_str()) || !group.routes.iter().any(|r| r == route) {
                continue;
            }
            claimed.insert(route.as_str());
            routes.push(route.clone());
        }
        groups.push(LayoutGroup { id: group.id.clone(), name: group.name.clone(), routes });
    }
    let ungrouped: Vec<String> = flow
        .iter()
        .filter(|route| !claimed.contains(route.as_str()))
        .cloned()
        .collect();
    (groups, ungrouped)
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
        page_labels: doc
            .page_labels
            .into_iter()
            .filter(|(route, _)| known.contains(route.as_str()))
            .collect(),
    }
}
