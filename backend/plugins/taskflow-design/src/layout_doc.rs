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

/// The id alphabet for minted group ids: lowercase base36, so an id is a single
/// URL-safe token with nothing to escape.
const ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
/// 36^12 is a shade under 2^63, so one `u64` of entropy fills an id exactly.
const GROUP_ID_DIGITS: usize = 12;

/// Mint a group id not already present in `existing`.
///
/// The panel mints its own as `g{time36}{seq36}` (`design-layout.ts:91`) from a
/// clock and a module-level counter, neither of which a server has. Uniqueness
/// is per-project only (spec §4 D3), so a random draw checked against this
/// document's ids is enough, and the `g` prefix keeps a minted id in the same
/// family as one the panel made.
pub fn mint_group_id(existing: &[String]) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    loop {
        // `RandomState` is seeded per process from the OS, so this is not a
        // predictable counter — and it needs no dependency the plugin lacks.
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_usize(existing.len());
        let mut n = hasher.finish();

        let mut id = String::with_capacity(1 + GROUP_ID_DIGITS);
        id.push('g');
        for _ in 0..GROUP_ID_DIGITS {
            id.push(ID_ALPHABET[(n % 36) as usize] as char);
            n /= 36;
        }

        if !existing.iter().any(|e| e == &id) {
            return id;
        }
    }
}

/// Append a new empty group. Returns the document and the minted id.
///
/// The name rules — non-blank, length, uniqueness, the group cap — live in
/// `validate` and are deliberately NOT duplicated here, so create and rename
/// refuse a bad name through exactly the code that refuses it on the operator
/// route. A caller must validate the result before storing it.
pub fn create_group(doc: LayoutDoc, name: &str) -> (LayoutDoc, String) {
    let existing: Vec<String> = doc.groups.iter().map(|g| g.id.clone()).collect();
    let id = mint_group_id(&existing);
    let mut groups = doc.groups;
    groups.push(LayoutGroup {
        id: id.clone(),
        name: name.trim().to_string(),
        routes: Vec::new(),
    });
    (LayoutDoc { groups, ..doc }, id)
}

/// Rename one group. Membership and order are untouched — moving pages is
/// `place_page`'s job, so a rename can never empty a group by accident.
pub fn rename_group(doc: LayoutDoc, group_id: &str, name: &str) -> Result<LayoutDoc, String> {
    let mut groups = doc.groups;
    let group = groups
        .iter_mut()
        .find(|g| g.id == group_id)
        .ok_or_else(|| format!("no group with id \"{group_id}\""))?;
    group.name = name.trim().to_string();
    Ok(LayoutDoc { groups, ..doc })
}

/// Move one group to a 1-based slot in the group list.
///
/// A MOVE, not a swap: removing then inserting displaces the groups between,
/// which is what the panel's `moveGroup` does (`design-layout.ts:209`) and what
/// "put this group third" means to a person.
///
/// A slot outside `1..=len` is refused rather than clamped, because a clamped
/// move lands somewhere the caller did not ask for — and a caller told the range
/// can re-read and ask for a slot that exists.
pub fn move_group(doc: LayoutDoc, group_id: &str, position: usize) -> Result<LayoutDoc, String> {
    let mut groups = doc.groups;
    let from = groups
        .iter()
        .position(|g| g.id == group_id)
        .ok_or_else(|| format!("no group with id \"{group_id}\""))?;
    let len = groups.len();
    if position < 1 || position > len {
        return Err(format!(
            "position {position} is out of range: there are {len} group(s), so 1..={len} is valid"
        ));
    }
    let group = groups.remove(from);
    groups.insert(position - 1, group);
    Ok(LayoutDoc { groups, ..doc })
}

/// Place `route` into a group and/or at a position.
///
/// Membership lives in a group's `routes`; position lives in the global
/// `route_order`. This writes both, so "move it and put it here" is one call
/// rather than two that can half-succeed (spec §6).
///
/// `position` is 1-based WITHIN THE RESULTING SECTION — the numbering the Pages
/// panel shows, not an index into the flow, which is global and sparse and
/// which no reader ever sees. `len + 1` is the append slot; anything outside
/// `1..=len + 1` is refused rather than clamped. A position not asked for at all
/// joins the section at its end, which is the slot `assignRoute` appends to.
///
/// The flow comes back MATERIALISED (spec §4 D6): `route_order` names every page
/// afterwards. Behaviourally invisible — `resolve_route_order` already appends
/// an unnamed page — but it means a placement expresses the whole arrangement
/// rather than part of it, which is what makes a position mean anything.
///
/// A placement touches exactly two sections: the one the page LEFT and the one
/// it JOINED. A third section's numbering cannot move, because its members'
/// relative order in the flow is untouched by inserting a page that is not one
/// of them — worth stating because the opposite is an easy thing to believe
/// about a global flow, and `placing_a_page_leaves_other_sections_alone` pins
/// it. Within the two affected sections, the other pages DO renumber.
pub fn place_page(
    doc: LayoutDoc,
    known_routes: &[String],
    route: &str,
    group_id: Option<&str>,
    position: Option<usize>,
) -> Result<LayoutDoc, String> {
    if !known_routes.iter().any(|r| r == route) {
        return Err(format!("\"{route}\" is not a page in this project"));
    }
    if let Some(gid) = group_id {
        if !doc.groups.iter().any(|g| g.id == gid) {
            return Err(format!("no group with id \"{gid}\""));
        }
    }

    // The section the route lands in: the named group, else whatever claims it
    // today, else ungrouped. Read from the ORIGINAL document, before the
    // membership edit below, because that is what "its current section" means.
    let target: Option<String> = match group_id {
        Some(gid) => Some(gid.to_string()),
        None => doc
            .groups
            .iter()
            .find(|g| g.routes.iter().any(|r| r == route))
            .map(|g| g.id.clone()),
    };

    // The flow, resolved before the membership edit: a position is applied to
    // the arrangement the caller is looking at, not to the stored array, which
    // names only the pages the document was last written with.
    let mut flow = resolve_route_order(&doc, known_routes);
    flow.retain(|r| r != route);

    // Membership: exactly one group claims a route. A route two groups claim
    // displays under the first only (`panel_sections`), so leaving it in both
    // would store a claim no reader ever shows.
    let mut groups = doc.groups;
    for group in groups.iter_mut() {
        group.routes.retain(|r| r != route);
    }
    if let Some(gid) = &target {
        if let Some(group) = groups.iter_mut().find(|g| &g.id == gid) {
            // Assignment order — `assignRoute` appends, and position is carried
            // by the flow, not by this array.
            group.routes.push(route.to_string());
        }
    }

    let in_section = |candidate: &str, groups: &[LayoutGroup]| -> bool {
        match &target {
            Some(gid) => groups
                .iter()
                .any(|g| &g.id == gid && g.routes.iter().any(|r| r == candidate)),
            None => !groups.iter().any(|g| g.routes.iter().any(|r| r == candidate)),
        }
    };

    // Indices in `flow` of the pages already in the target section, in order.
    let section: Vec<usize> = flow
        .iter()
        .enumerate()
        .filter(|&(_, candidate)| in_section(candidate, &groups))
        .map(|(i, _)| i)
        .collect();

    let len = section.len();
    let at = match position {
        // No position asked for: join at the end of the section.
        None => len,
        Some(0) => {
            return Err(format!(
                "position 0 is out of range: positions start at 1, so 1..={} is valid",
                len + 1
            ))
        }
        Some(p) if p > len + 1 => {
            return Err(format!(
                "position {p} is out of range: this section holds {len} page(s), so 1..={} is valid",
                len + 1
            ))
        }
        Some(p) => p - 1,
    };

    // `at < len` sits the route immediately before the page currently holding
    // that slot. `at == len` (the append slot) sits it immediately after the
    // last member, or at the end of the flow when the section is empty.
    let insert_at = if at < len {
        section[at]
    } else {
        section.last().map(|i| i + 1).unwrap_or(flow.len())
    };
    flow.insert(insert_at, route.to_string());

    Ok(LayoutDoc {
        view: doc.view,
        route_order: flow,
        groups,
        page_labels: doc.page_labels,
    })
}

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

/// The name a page is listed under: its label if the document has one, else the
/// manifest's own title.
///
/// The server's half of `pageLabel` (`v2_fe/src/lib/design-layout.ts`), and the
/// composite `agent_views::read_layout` writes into `pages[].name`. It lives
/// here, beside the panel's other two rules, so the shared case table can pin
/// it: the label-or-title CHOICE is implemented twice — here and in the client —
/// and a table asserting only the flow and the sections left it free to drift
/// (emptying `pageLabels` inside `normalizeLayout` kept both readers green).
///
/// A label is ABSENT rather than blank for a page that has never been renamed
/// (`validate` refuses a blank one), so absence is the fallback case and this
/// trims nothing. `pageLabel` re-checks its label for truthiness as
/// belt-and-braces over a document that has not been through `normalizeLayout`.
pub fn page_name(doc: &LayoutDoc, route: &str, title: &str) -> String {
    doc.page_labels.get(route).cloned().unwrap_or_else(|| title.to_string())
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
