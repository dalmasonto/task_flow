
use taskflow_design::layout_doc::{
    mint_edge_id,
    create_group, default_doc, filter_to_known, mint_group_id, move_group, page_name,
    panel_sections, parse, place_page, rename_group, resolve_route_order, to_json_string, to_value,
    validate, LayoutDoc, LayoutGroup, MAX_GROUPS, MAX_LABEL, link_pages, unlink_pages, update_link,
    set_position, find_edge, FlowEdge, FlowPosition, MAX_EDGES, MAX_EDGE_LABEL, MAX_COORD,
};
use taskflow_design::models::DesignView;

fn group(id: &str, name: &str, routes: &[&str]) -> LayoutGroup {
    LayoutGroup {
        id: id.into(),
        name: name.into(),
        routes: routes.iter().map(|r| r.to_string()).collect(),
    }
}

fn known() -> Vec<String> {
    ["/", "/login", "/signup"].iter().map(|s| s.to_string()).collect()
}

// A manifest of the case's choosing. `known()` is the one most cases use; the
// write operations are about the routes they name, so the cases below say
// exactly which pages exist rather than borrowing three that they do not.
fn known_of(routes: &[&str]) -> Vec<String> {
    routes.iter().map(|s| s.to_string()).collect()
}

fn doc(view: DesignView, groups: Vec<LayoutGroup>) -> LayoutDoc {
    LayoutDoc { view, route_order: vec!["/".into()], groups, ..default_doc() }
}

// A document with a flow of the case's choosing, where `doc()` hardcodes `["/"]`
// and every existing case is written against that. Only the flow a document
// resolves to needs this; the group operations read the group list alone.
fn doc_with_flow(flow: &[&str], groups: Vec<LayoutGroup>) -> LayoutDoc {
    LayoutDoc {
        view: DesignView::Groups,
        route_order: flow.iter().map(|s| s.to_string()).collect(),
        groups,
        ..default_doc()
    }
}

#[test]
fn default_is_rows_with_nothing_grouped() {
    let d = default_doc();
    assert_eq!(d.view, DesignView::Rows);
    assert!(d.groups.is_empty());
    assert!(d.route_order.is_empty());
}

#[test]
fn round_trips_through_camel_case_json() {
    let d = doc(DesignView::Groups, vec![group("g1", "Auth", &["/login"])]);
    let json = to_json_string(&d);
    // The wire field is `routeOrder`, and the view is a lowercase string.
    assert!(json.contains("\"routeOrder\""), "{json}");
    assert!(json.contains("\"groups\""), "{json}");
    assert!(json.contains("\"view\":\"groups\""), "{json}");
    assert_eq!(parse(&json).unwrap(), d);
}

#[test]
fn missing_view_defaults_to_rows_and_extra_fields_are_ignored() {
    // Review Focus #3: forward/backward compatibility of the stored document.
    let d = parse(r#"{"groups":[],"routeOrder":["/"],"futureField":1}"#).unwrap();
    assert_eq!(d.view, DesignView::Rows);
    assert_eq!(d.route_order, vec!["/".to_string()]);
}

#[test]
fn garbage_json_is_an_error_not_a_panic() {
    // Review Focus #1: the handler falls back to the default on this.
    assert!(parse("not json at all").is_err());
    assert!(parse(r#"{"groups":"auth"}"#).is_err());
    assert!(parse(r#"{"groups":[{"id":"g1"}]}"#).is_err());
}

#[test]
fn rejects_unknown_view_name() {
    assert!(validate(doc(DesignView::Rows, vec![]), &known()).is_ok());
    assert!(parse(r#"{"view":"diagonal","groups":[],"routeOrder":[]}"#).is_err());
}

#[test]
fn rejects_more_than_max_groups() {
    let many: Vec<LayoutGroup> = (0..=MAX_GROUPS)
        .map(|i| group(&format!("g{i}"), &format!("G{i}"), &[]))
        .collect();
    assert!(validate(doc(DesignView::Groups, many), &known()).is_err());
}

#[test]
fn rejects_duplicate_names_case_insensitively_and_untrimmed() {
    // Review Focus #4: padding and case are the same group to a human.
    let dupes = vec![group("g1", "Auth", &[]), group("g2", "auth", &[])];
    assert!(validate(doc(DesignView::Groups, dupes), &known()).is_err());

    let padded = vec![group("g1", "Auth", &[]), group("g2", " Auth ", &[])];
    assert!(validate(doc(DesignView::Groups, padded), &known()).is_err());

    let empty = vec![group("g1", "   ", &[])];
    assert!(validate(doc(DesignView::Groups, empty), &known()).is_err());

    let too_long = vec![group("g1", &"x".repeat(41), &[])];
    assert!(validate(doc(DesignView::Groups, too_long), &known()).is_err());
}

#[test]
fn rejects_a_route_in_two_groups_and_unknown_routes() {
    let twice = vec![group("g1", "Auth", &["/login"]), group("g2", "More", &["/login"])];
    assert!(validate(doc(DesignView::Groups, twice), &known()).is_err());

    // A ghost route would render an empty board forever.
    let ghost = vec![group("g1", "Auth", &["/nope"])];
    assert!(validate(doc(DesignView::Groups, ghost), &known()).is_err());
}

#[test]
fn validate_normalises_names_on_the_way_through() {
    let d = validate(
        doc(DesignView::Groups, vec![group("g1", "  Auth  ", &["/login"])]),
        &known(),
    )
    .unwrap();
    assert_eq!(d.groups[0].name, "Auth");
}

// The GROUP ORDER, at the seam the client writes to. The Pages panel's group
// arrows permute `doc.groups` and PUT the whole document back — the first
// affordance in the UI that reorders groups at all — and this is the claim that
// order survives the write path, which had been verified by reading three times
// (the plan, the implementer, the reviewer) and by a run never.
//
// The permutation is made the way the CLIENT makes it and sent the way the
// client sends it: the same document with its two groups the other way round,
// through `to_json_string` and back through `parse`, because `validate` on a
// `Vec` this test built itself is not the round trip the panel's arrows take.
// Both orders are asserted, and the second is deliberately anti-alphabetical —
// "Ops" before "Auth" — so a name sort anywhere in the pipeline fails this
// rather than passing it (and the first catches the mirror: a reverse).
#[test]
fn validate_keeps_the_group_order_it_is_given() {
    let forwards = doc(
        DesignView::Groups,
        vec![group("g1", "Auth", &["/login"]), group("g2", "Ops", &["/signup"])],
    );
    let accepted = validate(forwards.clone(), &known()).expect("a document the client can build");

    // The permutation the panel's arrows write, on the wire.
    let permuted = LayoutDoc {
        groups: vec![forwards.groups[1].clone(), forwards.groups[0].clone()],
        ..forwards
    };
    let reparsed = parse(&to_json_string(&permuted)).expect("the client's own JSON");
    let reversed = validate(reparsed, &known()).expect("the same two groups, reordered");

    let ids = |d: &LayoutDoc| d.groups.iter().map(|g| g.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&accepted), vec!["g1".to_string(), "g2".to_string()]);
    assert_eq!(ids(&reversed), vec!["g2".to_string(), "g1".to_string()]);

    // And the groups move WHOLE: the pages travel with the group they are in,
    // so a reorder cannot silently re-assign them to whichever group now sits
    // in their old position.
    assert_eq!(reversed.groups[0].routes, vec!["/signup".to_string()]);
    assert_eq!(reversed.groups[1].routes, vec!["/login".to_string()]);
}

#[test]
fn filter_keeps_groups_whose_routes_all_vanished() {
    // Review Focus #2: deleting pages must not delete the grouping.
    let d = doc(
        DesignView::Groups,
        vec![group("g1", "Auth", &["/login", "/gone"]), group("g2", "Dead", &["/gone"])],
    );
    let out = filter_to_known(d, &known());
    assert_eq!(out.view, DesignView::Groups, "view survives");
    assert_eq!(out.groups[0].routes, vec!["/login".to_string()]);
    assert!(out.groups[1].routes.is_empty(), "empty group survives");
    assert_eq!(out.route_order, vec!["/".to_string()]);
}

#[test]
fn filter_drops_vanish_via_empty_manifest() {
    let d = doc(DesignView::Groups, vec![group("g1", "Auth", &["/login"])]);
    let out = filter_to_known(d, &[]);
    assert_eq!(out.groups.len(), 1);
    assert!(out.groups[0].routes.is_empty());
    assert!(out.route_order.is_empty());
}

#[test]
fn to_value_emits_the_wire_shape() {
    let v = to_value(&doc(DesignView::Bands, vec![]));
    assert_eq!(v["view"], "bands");
    assert!(v["routeOrder"].is_array());
    assert!(v["groups"].is_array());
}

#[test]
fn page_labels_round_trip_as_camel_case() {
    let mut d = doc(DesignView::Rows, vec![]);
    d.page_labels.insert("/login".into(), "Sign in".into());
    let json = to_json_string(&d);
    assert!(json.contains("\"pageLabels\""), "{json}");
    assert_eq!(parse(&json).unwrap(), d);
}

#[test]
fn a_document_without_page_labels_still_parses() {
    // Every document written before this field existed must keep working.
    let d = parse(r#"{"view":"rows","routeOrder":[],"groups":[]}"#).unwrap();
    assert!(d.page_labels.is_empty());
}

#[test]
fn validate_trims_labels_and_refuses_bad_ones() {
    let mut ok = doc(DesignView::Rows, vec![]);
    ok.page_labels.insert("/login".into(), "  Sign in  ".into());
    let out = validate(ok, &known()).unwrap();
    assert_eq!(out.page_labels["/login"], "Sign in");

    // empty after trimming
    let mut blank = doc(DesignView::Rows, vec![]);
    blank.page_labels.insert("/login".into(), "   ".into());
    assert!(validate(blank, &known()).is_err());

    // over the cap
    let mut long = doc(DesignView::Rows, vec![]);
    long.page_labels.insert("/login".into(), "x".repeat(MAX_LABEL + 1));
    assert!(validate(long, &known()).is_err());

    // a route that is not a page — same rule as group routes
    let mut ghost = doc(DesignView::Rows, vec![]);
    ghost.page_labels.insert("/nope".into(), "Gone".into());
    assert!(validate(ghost, &known()).is_err());
}

// The FLOW, resolved. `route_order` is sparse by nature — a page added after
// the document was written is not in it, and the read has just dropped the pages
// that are gone — so "the order the pages are presented in" is not the stored
// array. The client has resolved this since the pages panel landed
// (`resolveRouteOrder`); these are the server's half of that rule, which the
// agent read needs before it can answer at all.
#[test]
fn the_flow_is_the_stored_order_then_every_page_it_does_not_name() {
    let d = LayoutDoc {
        view: DesignView::Rows,
        route_order: vec!["/signup".into()],
        groups: vec![],
        ..default_doc()
    };
    // `/login` is named and comes first; `/` and `/signup` are appended in the
    // order the manifest arrived in, because the stored flow never named them.
    assert_eq!(resolve_route_order(&d, &known()), vec!["/signup", "/", "/login"]);
}

#[test]
fn the_flow_is_a_permutation_of_the_pages_that_exist() {
    // Total and lossless, including the two states a stored flow is in by
    // accident: an entry for a page that is gone (dropped) and a page named
    // twice (first-wins, the rule `validate` stores by).
    let d = LayoutDoc {
        view: DesignView::Rows,
        route_order: vec!["/gone".into(), "/login".into(), "/login".into(), "/".into()],
        groups: vec![],
        ..default_doc()
    };
    let flow = resolve_route_order(&d, &known());
    assert_eq!(flow, vec!["/login", "/", "/signup"]);
    let mut sorted = flow.clone();
    sorted.sort();
    let mut pages = known();
    pages.sort();
    assert_eq!(sorted, pages, "every page exactly once: {flow:?}");
}

#[test]
fn an_empty_flow_falls_back_to_the_manifest_order() {
    // A fresh project has no stored order at all, and that must read as the
    // pages in their manifest order rather than as nothing.
    assert_eq!(resolve_route_order(&default_doc(), &known()), known());
}

// The panel's two halves. What the agent must be able to see is the arrangement
// as the operator sees it, and the panel reaches it through two transformations
// the raw document does not express: a group's pages are read in FLOW order (its
// own array is assignment order), and the pages no group claims are listed as
// their own section — a partition, so nothing is listed twice and nothing
// vanishes.
#[test]
fn a_groups_pages_are_listed_in_flow_order_not_array_order() {
    let d = LayoutDoc {
        view: DesignView::Groups,
        // The flow says /signup then /login; the group's own array says the
        // opposite, which is the order the pages were assigned in.
        route_order: vec!["/signup".into(), "/login".into(), "/".into()],
        groups: vec![group("g1", "Auth", &["/login", "/signup"])],
        ..default_doc()
    };
    let (groups, ungrouped) = panel_sections(&d, &known());
    assert_eq!(groups[0].routes, vec!["/signup".to_string(), "/login".to_string()]);
    assert_eq!(groups[0].name, "Auth", "the name travels with the group");
    assert_eq!(ungrouped, vec!["/".to_string()]);
}

#[test]
fn the_two_halves_partition_the_pages_even_when_both_states_are_broken() {
    // Two states a hand-edited document can be in and the panel still has to
    // draw: a page two groups claim, and a group whose only page is gone.
    let d = LayoutDoc {
        view: DesignView::Groups,
        route_order: vec![],
        groups: vec![
            group("g1", "Auth", &["/login", "/gone"]),
            group("g2", "Again", &["/login"]),
            group("g3", "Empty", &[]),
        ],
        ..default_doc()
    };
    let (groups, ungrouped) = panel_sections(&d, &known());
    assert_eq!(groups[0].routes, vec!["/login".to_string()], "the FIRST group claims it");
    assert!(groups[1].routes.is_empty(), "and the second does not double-list it");
    assert!(groups[2].routes.is_empty(), "an empty group keeps its section");
    assert_eq!(groups.len(), 3, "no group is dropped");
    assert_eq!(ungrouped, vec!["/".to_string(), "/signup".to_string()]);

    let listed: Vec<String> = groups
        .iter()
        .flat_map(|g| g.routes.iter().cloned())
        .chain(ungrouped.iter().cloned())
        .collect();
    let mut sorted = listed.clone();
    sorted.sort();
    assert_eq!(sorted, known(), "every page listed exactly once: {listed:?}");
}

/// The shared case table, read by `include_str!` so a moved or deleted file is a
/// COMPILE error rather than a test that quietly stops running.
///
/// The same file is read by `v2_fe/src/pages/design/layout-panel-cases.test.ts`,
/// which runs the two client functions these mirror (`resolveRouteOrder`,
/// `groupedPages`) over the same cases. The rules are implemented twice on
/// purpose — the panel resolves locally because it renders optimistically, the
/// server resolves because the agent read must hand back the arrangement, not
/// the document — but they must not DRIFT, and both have changed once already.
/// A comment naming the other implementation cannot fail; this can.
///
/// It lives under `v2_fe/` rather than beside this file because the client
/// reader cannot use `node:fs`: `v2_fe/tsconfig.app.json` declares
/// `types: ["vite/client"]`, so a `node:fs` import in `src/` fails that build
/// (TS2591) — the file moved here, and the client reads it with `?raw`, rather
/// than the tsconfig widening the application's type surface to Node. ONE file
/// in one place is the property the table rests on; a copy per reader is the
/// drift this test exists to catch.
const PANEL_CASES: &str = include_str!("../../../../v2_fe/fixtures/layout-panel-cases.json");

/// The cases this table is pinned to carry, by NAME.
///
/// A floor (`cases.len() >= 5`, against a table of six) held nothing: delete a
/// case and both readers stayed green, so the guard could be retired by removing
/// the thing it guards — which is what a reviewer did, with the client drift it
/// was there to catch still live. Names also fail a case that was REPLACED
/// rather than deleted, because the old name is then absent.
///
/// `v2_fe/src/pages/design/layout-panel-cases.test.ts` carries the same list,
/// because neither reader can derive it from the other and a name is what makes
/// the two tables provably the same table. Adding a case is a deliberate edit
/// HERE as well — that is the point, not a cost.
const PANEL_CASE_NAMES: [&str; 7] = [
    "a fresh project lists every page ungrouped, in manifest order",
    "the stored flow orders the pages it names, and every page it does not name is appended in manifest order",
    "a group's pages are listed in flow order, not in the order its own routes array holds",
    "groups keep the document's order, and the ungrouped pages are the complement",
    "a route two groups claim lists under the first of them, and an empty group keeps its section",
    "a hand-edited document naming a page that is gone, and naming one twice, keeps its grouping and drops what it cannot place",
    "a page reads as its label where it has one, and as the manifest title where it does not",
];

#[test]
fn the_panels_resolution_matches_the_shared_case_table() {
    let table: serde_json::Value =
        serde_json::from_str(PANEL_CASES).expect("the shared case table parses");
    let cases = table["cases"].as_array().expect("cases is an array");

    let case_names: Vec<&str> = cases
        .iter()
        .map(|case| case["name"].as_str().expect("a case names itself"))
        .collect();
    for expected in PANEL_CASE_NAMES {
        assert!(
            case_names.contains(&expected),
            "the shared case table no longer carries the case {expected:?} — it carries \
             {case_names:?}. A case is not deleted to make a suite pass: fix the rule it \
             caught, or if the case is genuinely gone, say so where both readers read it."
        );
    }
    assert_eq!(
        case_names.len(),
        PANEL_CASE_NAMES.len(),
        "the shared case table carries cases this pin does not name — a deliberate addition \
         updates PANEL_CASE_NAMES in BOTH readers, so that neither side can be reading a \
         table the other is not: {case_names:?}"
    );

    for case in cases {
        let name = case["name"].as_str().expect("a case names itself");
        let manifest: Vec<String> = case["manifest"]
            .as_array()
            .unwrap_or_else(|| panic!("{name}: manifest is an array"))
            .iter()
            .map(|r| r.as_str().expect("a manifest entry is a route").to_string())
            .collect();
        let doc: LayoutDoc = serde_json::from_value(case["doc"].clone())
            .unwrap_or_else(|err| panic!("{name}: doc does not parse as a LayoutDoc: {err}"));
        let expect = &case["expect"];

        assert_eq!(
            serde_json::to_value(resolve_route_order(&doc, &manifest)).unwrap(),
            expect["flow"],
            "flow: {name}"
        );
        let (groups, ungrouped) = panel_sections(&doc, &manifest);
        assert_eq!(
            serde_json::to_value(&groups).unwrap(),
            expect["groups"],
            "groups: {name}"
        );
        assert_eq!(
            serde_json::to_value(&ungrouped).unwrap(),
            expect["ungrouped"],
            "ungrouped: {name}"
        );

        // The label-or-title composite, which the table did not pin at all: the
        // same choice is written twice (`layout_doc::page_name` here,
        // `pageLabel` in the client), and emptying `pageLabels` in the client's
        // `normalizeLayout` left this table green. Every page of the manifest is
        // asserted, not just the labelled ones — naming only the labelled pages
        // would make a reader that ignores labels entirely look correct.
        //
        // `title` is the ROUTE in both harnesses (the fixture says why), so this
        // pins the choice between label and title, not a title's derivation.
        let names: serde_json::Map<String, serde_json::Value> = manifest
            .iter()
            .map(|route| {
                (
                    route.clone(),
                    serde_json::Value::String(page_name(&doc, route, route)),
                )
            })
            .collect();
        assert_eq!(
            serde_json::Value::Object(names),
            expect["names"],
            "names: {name}"
        );
    }
}

#[test]
fn a_named_flow_only_reorders_pages_the_project_still_has() {
    // The read path end to end, over the two functions together: the document
    // arrived filtered (`filter_to_known`), and the flow it resolves to names no
    // page that is gone.
    let mut d = doc(DesignView::Groups, vec![group("g1", "Auth", &["/login", "/gone"])]);
    d.route_order = vec!["/gone".into(), "/login".into()];
    let filtered = filter_to_known(d, &known());
    let flow = resolve_route_order(&filtered, &known());
    assert_eq!(flow, vec!["/login", "/", "/signup"]);
}

#[test]
fn filter_drops_labels_for_vanished_routes() {
    let mut d = doc(DesignView::Rows, vec![]);
    d.page_labels.insert("/login".into(), "Sign in".into());
    d.page_labels.insert("/gone".into(), "Removed".into());
    let out = filter_to_known(d, &known());
    assert_eq!(out.page_labels.len(), 1);
    assert_eq!(out.page_labels["/login"], "Sign in");
}

// The group write operations. `create_group` and `rename_group` read the group
// list and nothing else — not the flow, not the manifest — so what a NAME may be
// is settled in `validate` alone, and these cases pin the rest: the id a group
// gets, and which parts of the document a write is allowed to touch.

#[test]
fn a_minted_id_is_a_g_and_does_not_collide() {
    let existing = vec!["gabc".to_string(), "gdef".to_string()];
    let id = mint_group_id(&existing);
    assert!(id.starts_with('g'), "same family as the panel's: {id}");
    assert_eq!(id.len(), 13, "g + 12 base36 chars: {id}");
    assert!(
        id[1..].chars().all(|c| c.is_ascii_digit() || ('a'..='z').contains(&c)),
        "lowercase base36 only: {id}"
    );
    assert!(!existing.contains(&id), "and not already taken");
}

#[test]
fn minted_ids_differ_across_calls() {
    let mut seen = std::collections::HashSet::new();
    for _ in 0..64 {
        assert!(seen.insert(mint_group_id(&[])), "two draws collided");
    }
}

#[test]
fn create_group_appends_an_empty_group_and_returns_its_id() {
    let (doc, id) = create_group(doc_with_flow(&["/"], vec![]), "  Player  ");
    assert_eq!(doc.groups.len(), 1);
    assert_eq!(doc.groups[0].id, id);
    assert_eq!(doc.groups[0].name, "Player", "the name is trimmed");
    assert!(doc.groups[0].routes.is_empty(), "a new group holds nothing");
}

#[test]
fn create_group_refuses_through_validate_not_here() {
    // The rules live in `validate` and nowhere else, so this function does not
    // duplicate them — the caller validates the result. A duplicate name is
    // therefore still produced here and refused there.
    //
    // The flow names the one page the manifest has, so `validate` has nothing
    // else it could object to: the error below is the name and not a stale route.
    let (doc, _) = create_group(doc_with_flow(&["/a"], vec![group("g1", "Player", &[])]), "player");
    assert_eq!(doc.groups.len(), 2);
    let err =
        validate(doc, &known_of(&["/a"])).expect_err("refused by validate, case-insensitively");
    assert!(err.contains("already used"), "and refused for the name: {err}");
}

#[test]
fn rename_group_changes_only_the_name() {
    let before = doc_with_flow(&["/a"], vec![group("g1", "Old", &["/a"])]);
    let after = rename_group(before.clone(), "g1", "New").expect("renames");
    assert_eq!(after.groups[0].name, "New");
    assert_eq!(after.groups[0].routes, vec!["/a".to_string()], "membership untouched");
    assert_eq!(after.route_order, before.route_order);
}

#[test]
fn rename_group_refuses_an_unknown_id() {
    let err =
        rename_group(doc_with_flow(&["/"], vec![group("g1", "A", &[])]), "nope", "B").unwrap_err();
    assert!(err.contains("nope"), "the message names the id: {err}");
}

// `move_group`, the write that reorders the groups instead of editing one. The
// panel's group arrows are a MOVE (`design-layout.ts:209`): the group is removed
// and inserted at the slot it was sent to, which slides the groups in between
// one place the other way — so "put this group third" means third, to the agent
// and to the operator alike. Slots are 1-based, and one outside the list is
// REFUSED rather than clamped: a clamped move lands somewhere the caller did not
// ask for, which is worse than a sentence it can read and call again.
//
// No group in these cases claims a page, so their flow is empty: `move_group`
// reads the group list and nothing else.

#[test]
fn move_group_moves_rather_than_swaps() {
    // A fresh three-group document per call: the function takes the document by
    // value, and one case's move must not be the next case's input.
    let three = || vec![group("g1", "A", &[]), group("g2", "B", &[]), group("g3", "C", &[])];

    // The panel's `moveGroup` is a move: the group at the target index is
    // displaced, not exchanged. Agent and operator must agree.
    let before = doc_with_flow(&[], three());
    let after = move_group(before, "g1", 2).expect("moves");
    let order: Vec<&str> = after.groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(order, vec!["B", "A", "C"], "A moves to slot 2; B slides up");

    // Neighbours cannot tell a move from a swap — B first and A second either
    // way — so a slot that is NOT adjacent is what pins it: A takes the slot C
    // held and C slides up, where swapping the two ends would have left C in A's
    // old slot. The last slot is a slot like any other (the range is 1..=len),
    // so the insert lands at the end of the shortened list rather than past it.
    let after = move_group(doc_with_flow(&[], three()), "g1", 3).expect("moves");
    let order: Vec<&str> = after.groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(order, vec!["B", "C", "A"], "A moves to slot 3; B and C slide up");

    // And upwards, where the groups the group passes slide DOWN instead: the
    // group lands IN the slot it was given rather than one place short of it,
    // and the first slot is a slot like any other.
    let after = move_group(doc_with_flow(&[], three()), "g3", 1).expect("moves");
    let order: Vec<&str> = after.groups.iter().map(|g| g.name.as_str()).collect();
    assert_eq!(order, vec!["C", "A", "B"], "C moves to slot 1; A and B slide down");
}

#[test]
fn move_group_to_the_same_place_is_a_no_op() {
    let before = doc_with_flow(&[], vec![group("g1", "A", &[]), group("g2", "B", &[])]);
    let after = move_group(before.clone(), "g1", 1).expect("moves");
    assert_eq!(after.groups, before.groups);
}

#[test]
fn move_group_refuses_a_position_outside_the_list() {
    let before = doc_with_flow(&[], vec![group("g1", "A", &[]), group("g2", "B", &[])]);
    let err = move_group(before.clone(), "g1", 3).unwrap_err();
    assert!(err.contains("1..=2"), "names the valid range: {err}");
    assert!(move_group(before.clone(), "g1", 0)
        .unwrap_err()
        .contains("1..=2"));
    // Refused, not clamped: a clamp would have returned a document with the group
    // parked at an end, so the `.unwrap_err()` above is the assertion. That the
    // caller's own `before` is untouched needs no assertion — `move_group` takes
    // the document by VALUE, so no implementation could have changed the caller's
    // copy, and an assertion that cannot fail is worse than none.
}

#[test]
fn move_group_refuses_an_unknown_id() {
    let err = move_group(doc_with_flow(&[], vec![group("g1", "A", &[])]), "nope", 1).unwrap_err();
    assert!(err.contains("nope"), "names the id: {err}");

    // The id is settled BEFORE the slot, as `find`/`findIndex` settle it in the
    // panel: an unknown id is reported as an unknown id even here, where no slot
    // could have been valid either, so the sentence is about the thing the
    // caller actually got wrong.
    let err = move_group(doc_with_flow(&[], vec![]), "nope", 1).unwrap_err();
    assert!(
        err.contains("nope"),
        "an empty document names the id too: {err}"
    );
}

// `place_page`, the write that moves a page BETWEEN sections and orders it
// within the one it lands in. It is the only write here that touches both halves
// of the document at once — membership lives in a group's `routes`, the position
// lives in the global flow — and both review risks of this task live in that
// pairing:
//
//  * a route two groups claim lists under the FIRST of them (`panel_sections`),
//    so a document that leaves a second claim behind stores a claim no reader
//    ever shows; and
//  * `position` is 1-based within the RESULTING SECTION — the numbering the
//    Pages panel shows — while storage keeps ONE flow for the whole project, so
//    the same number is a different flow index in a different section.
//
// A position outside the section, and a position that is not a position at all
// (0), are REFUSED rather than clamped: a clamped placement lands somewhere the
// caller did not ask for, which is worse than a sentence it can read and repeat.

/// The fixture the positional cases share: a flow over four pages where g1
/// claims the first two, so the ungrouped section is `/c /d` — and g2 is empty,
/// so a page can be moved into a group without landing in the section it left.
fn placed_doc() -> LayoutDoc {
    doc_with_flow(
        &["/a", "/b", "/c", "/d"],
        vec![group("g1", "One", &["/a", "/b"]), group("g2", "Two", &[])],
    )
}

#[test]
fn place_page_moves_a_page_into_a_group() {
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/c", Some("g1"), None).expect("places");
    assert_eq!(after.groups[0].routes.len(), 3, "g1 now claims three pages");
    assert!(after.groups[0].routes.contains(&"/c".to_string()));

    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/a", "/b", "/c"], "appended: no position asked for");
    assert_eq!(ungrouped, vec!["/d".to_string()]);
}

#[test]
fn place_page_removes_the_route_from_whatever_claimed_it() {
    // Review Focus 3: the panel shows a doubly-claimed route under the FIRST
    // group only, so a document claiming it twice displays it once — a
    // discrepancy nothing else would catch.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/a", Some("g2"), None).expect("places");
    let claims: Vec<&str> = after
        .groups
        .iter()
        .filter(|g| g.routes.iter().any(|r| r == "/a"))
        .map(|g| g.id.as_str())
        .collect();
    assert_eq!(claims.len(), 1, "claimed exactly once: {claims:?}");
    assert_eq!(claims[0], "g2");

    // And what the panel draws, which is what the leftover claim would have
    // hidden: g1 down to the page it still holds, /a under g2 alone, and the
    // ungrouped section untouched by any of it.
    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let one: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    let two: Vec<&str> = groups[1].routes.iter().map(String::as_str).collect();
    assert_eq!(one, vec!["/b"], "the section it left gave the page up");
    assert_eq!(two, vec!["/a"], "and the section it joined is the one that lists it");
    assert_eq!(ungrouped, vec!["/c".to_string(), "/d".to_string()]);
}

#[test]
fn place_page_puts_the_route_at_the_requested_position_in_its_section() {
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    // /d is the only ungrouped page; move it into g1 at position 1.
    let after = place_page(placed_doc(), &known_routes, "/d", Some("g1"), Some(1)).expect("places");
    let (groups, _) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/d", "/a", "/b"], "lands first, displacing the rest");
}

#[test]
fn place_page_reorders_within_the_current_section_when_no_group_is_given() {
    // /c and /d are ungrouped. Put /d first without touching membership.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let before = placed_doc();
    let after = place_page(before, &known_routes, "/d", None, Some(1)).expect("places");
    let (_, ungrouped) = panel_sections(&after, &known_routes);
    assert_eq!(ungrouped, vec!["/d".to_string(), "/c".to_string()]);
    assert_eq!(after.groups[0].routes.len(), 2, "membership untouched");
}

#[test]
fn place_page_reorders_within_a_named_group_the_page_is_already_in() {
    // The caller names the group the page is already in — the sibling of the
    // ungrouped case above, and what a "put /b first in g1" call looks like. The
    // page LEAVES the section before the slot is read, so its own membership is
    // not one of the positions: g1 holds /a /b, so a placement of /b offers
    // 1..=2 and no third. A write that counted the page as still in place would
    // offer a slot the resulting section does not have.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/b", Some("g1"), Some(1)).expect("places");
    let (groups, _) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/b", "/a"], "to the front of the group it was already in");

    let err = place_page(placed_doc(), &known_routes, "/b", Some("g1"), Some(3)).unwrap_err();
    assert!(err.contains("1..=2"), "two members, so two slots: {err}");
}

#[test]
fn place_page_appends_past_the_last_member() {
    // Review Focus 4: `len + 1` is the append slot and is legal. Anything
    // beyond it is refused rather than clamped — a clamped placement lands
    // somewhere the caller did not ask for, which is worse than a re-read.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/d", Some("g1"), Some(3)).expect("places");
    let (groups, _) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/a", "/b", "/d"]);
}

#[test]
fn place_page_refuses_a_position_beyond_the_append_slot() {
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let before = placed_doc();
    // g1 currently holds two pages, so 1..=3 is the valid range.
    let err = place_page(before.clone(), &known_routes, "/c", Some("g1"), Some(4)).unwrap_err();
    assert!(err.contains("1..=3"), "names the valid range: {err}");
    let err_zero = place_page(before, &known_routes, "/c", Some("g1"), Some(0)).unwrap_err();
    assert!(err_zero.contains("1..=3"), "1-based, so 0 is out: {err_zero}");
}

#[test]
fn place_page_refuses_an_unknown_route_or_group() {
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let err = place_page(placed_doc(), &known_routes, "/nope", None, None).unwrap_err();
    assert!(err.contains("/nope"), "names the route: {err}");
    let err = place_page(placed_doc(), &known_routes, "/c", Some("ghost"), None).unwrap_err();
    assert!(err.contains("ghost"), "names the group: {err}");
}

#[test]
fn placing_a_page_leaves_other_sections_alone() {
    // It is tempting to think a global flow means a placement ripples outward
    // through every section's numbering. It does not: a section's numbering is
    // that section's members in flow order, and inserting a page that is not a
    // member cannot reorder them. A placement touches the section it LEFT and
    // the section it JOINED — never a third. Pinned because the opposite is an
    // easy thing to believe and a hard thing to notice.
    let known_routes = known_of(&["/a", "/b", "/c", "/d", "/e"]);
    let before = doc_with_flow(
        &["/a", "/b", "/c", "/d", "/e"],
        vec![group("g1", "One", &["/a", "/b"]), group("g3", "Three", &["/e"])],
    );
    let after = place_page(before, &known_routes, "/c", Some("g1"), Some(1)).expect("places");

    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let three: Vec<&str> = groups
        .iter()
        .find(|g| g.id == "g3")
        .expect("g3 survives")
        .routes
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(three, vec!["/e"], "a section the write never named is untouched");
    assert_eq!(ungrouped, vec!["/d".to_string()], "and only the vacated section lost a page");
}

#[test]
fn placing_a_page_keeps_the_flow_a_permutation() {
    // The invariant the whole document rests on: every page exactly once.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let after = place_page(placed_doc(), &known_routes, "/d", Some("g1"), Some(2)).expect("places");
    let mut sorted = after.route_order.clone();
    sorted.sort();
    let mut expected = known_routes.clone();
    expected.sort();
    assert_eq!(sorted, expected, "no page dropped and none duplicated");
}

#[test]
fn place_page_positions_within_the_section_not_the_global_flow() {
    // Review Focus 4, the half the cases above cannot see. Every section they
    // place into sits at the HEAD of the flow — the pages preceding those
    // sections are none — so the same `position` happens to be the same flow
    // index, and a write that read it as an index into the flow would pass all
    // of them. Here the target section starts three pages in, and the two
    // readings disagree by exactly those three.
    let known_routes = known_of(&["/a", "/b", "/c", "/d", "/e"]);
    let before = doc_with_flow(
        &["/a", "/b", "/c", "/d", "/e"],
        vec![group("g1", "One", &["/a", "/b"]), group("g2", "Two", &["/d", "/e"])],
    );
    // The SLOT the route lands in is what separates the two readings, so the
    // position asked for is an interior one: /d holds the second slot of the
    // flow, and that is not where the second page of g2's section goes.
    let after = place_page(before, &known_routes, "/c", Some("g2"), Some(2)).expect("places");

    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let two: Vec<&str> = groups
        .iter()
        .find(|g| g.id == "g2")
        .expect("g2 survives")
        .routes
        .iter()
        .map(String::as_str)
        .collect();
    let one: Vec<&str> = groups
        .iter()
        .find(|g| g.id == "g1")
        .expect("g1 survives")
        .routes
        .iter()
        .map(String::as_str)
        .collect();
    assert_eq!(
        two,
        vec!["/d", "/c", "/e"],
        "second in its own section, which starts three pages into the flow"
    );
    assert_eq!(one, vec!["/a", "/b"], "and the section it left is untouched");
    assert!(ungrouped.is_empty(), "every page is claimed now: {ungrouped:?}");
}

#[test]
fn place_page_materialises_a_sparse_flow_over_every_page() {
    // The stored flow is SPARSE — a page added after the document was written is
    // not in it, so it names one page of the four the project has — and the
    // write comes back naming every page (spec §4 D6). `placed_doc`'s flow is
    // already complete, so the cases above cannot see this: leaving
    // `route_order` as it was found would pass every one of them, and a position
    // against a half-named arrangement would mean nothing.
    let known_routes = known_of(&["/a", "/b", "/c", "/d"]);
    let before = doc_with_flow(&["/b"], vec![group("g1", "One", &["/a", "/b"])]);
    // Resolves to /b /a /c /d, so g1's section is /b /a and /c lands first.
    let after = place_page(before, &known_routes, "/c", Some("g1"), Some(1)).expect("places");
    assert_eq!(
        after.route_order,
        vec!["/c", "/b", "/a", "/d"],
        "the whole arrangement, not the stored half of it"
    );

    // And the panel draws that flow: g1's three pages in the order the write
    // stored, not the order the group's own array holds.
    let (groups, ungrouped) = panel_sections(&after, &known_routes);
    let listed: Vec<&str> = groups[0].routes.iter().map(String::as_str).collect();
    assert_eq!(listed, vec!["/c", "/b", "/a"]);
    assert_eq!(ungrouped, vec!["/d".to_string()]);
}

// ---------------------------------------------------------------------------
// #508: the user flow — edges between pages and fixed canvas positions
// ---------------------------------------------------------------------------

fn edge(id: &str, from: &str, to: &str, label: Option<&str>) -> FlowEdge {
    FlowEdge { id: id.into(), from: from.into(), to: to.into(), label: label.map(Into::into) }
}

fn with_edges(edges: Vec<FlowEdge>) -> LayoutDoc {
    LayoutDoc { edges, ..default_doc() }
}

#[test]
fn edges_and_positions_round_trip_as_camel_case_json() {
    let mut d = with_edges(vec![edge("e1", "/", "/login", Some("existing user"))]);
    d.positions.insert("/".into(), FlowPosition { x: 10.5, y: -20.0 });
    let json = to_json_string(&d);
    assert!(json.contains(r#""edges":[{"id":"e1","from":"/","to":"/login","label":"existing user"}]"#), "{json}");
    assert!(json.contains(r#""positions":{"/":{"x":10.5,"y":-20.0}}"#), "{json}");
    assert_eq!(parse(&json).unwrap(), d);
}

#[test]
fn a_document_written_before_the_flow_still_parses() {
    let d = parse(r#"{"view":"rows","routeOrder":[],"groups":[]}"#).unwrap();
    assert!(d.edges.is_empty());
    assert!(d.positions.is_empty());
}

#[test]
fn an_unlabelled_edge_omits_the_label_key() {
    let json = to_json_string(&with_edges(vec![edge("e1", "/", "/login", None)]));
    assert!(!json.contains("label"), "{json}");
}

#[test]
fn validate_accepts_a_flow_and_normalises_labels() {
    let d = with_edges(vec![
        edge("e1", "/", "/login", Some("  existing user  ")),
        edge("e2", "/", "/signup", Some("   ")),
        // The reverse direction is a different arrow.
        edge("e3", "/login", "/", None),
    ]);
    let out = validate(d, &known()).expect("a valid flow");
    assert_eq!(out.edges[0].label.as_deref(), Some("existing user"));
    assert_eq!(out.edges[1].label, None, "a blank label is no label");
    assert_eq!(out.edges.len(), 3);
}

#[test]
fn validate_refuses_bad_edges() {
    let cases: Vec<(Vec<FlowEdge>, &str)> = vec![
        (vec![edge("e1", "/", "/nope", None)], "not a page"),
        (vec![edge("e1", "/ghost", "/", None)], "not a page"),
        (vec![edge("e1", "/", "/", None)], "itself"),
        (vec![edge("e1", "/", "/login", None), edge("e2", "/", "/login", Some("x"))], "already links"),
        (vec![edge("e1", "/", "/login", None), edge("e1", "/", "/signup", None)], "used twice"),
        (vec![edge("  ", "/", "/login", None)], "id"),
        (vec![edge("e1", "/", "/login", Some(&"x".repeat(MAX_EDGE_LABEL + 1)))], "limited"),
    ];
    for (edges, needle) in cases {
        let err = validate(with_edges(edges.clone()), &known()).expect_err(&format!("{edges:?}"));
        assert!(err.contains(needle), "{err} should mention {needle}");
    }
}

#[test]
fn validate_caps_the_edge_count() {
    let routes: Vec<String> = (0..30).map(|i| format!("/p{i}")).collect();
    let mut edges = Vec::new();
    'outer: for a in &routes {
        for b in &routes {
            if a != b {
                edges.push(edge(&format!("e{}", edges.len()), a, b, None));
                if edges.len() > MAX_EDGES {
                    break 'outer;
                }
            }
        }
    }
    let err = validate(with_edges(edges), &routes).unwrap_err();
    assert!(err.contains("at most"), "{err}");
}

#[test]
fn validate_clamps_positions_and_refuses_unknown_or_non_finite_ones() {
    let mut d = default_doc();
    d.positions.insert("/".into(), FlowPosition { x: 1e9, y: -1e9 });
    d.positions.insert("/login".into(), FlowPosition { x: 12.25, y: 0.0 });
    let out = validate(d, &known()).unwrap();
    assert_eq!(out.positions["/"], FlowPosition { x: MAX_COORD, y: -MAX_COORD });
    assert_eq!(out.positions["/login"], FlowPosition { x: 12.25, y: 0.0 });

    let mut ghost = default_doc();
    ghost.positions.insert("/nope".into(), FlowPosition { x: 0.0, y: 0.0 });
    assert!(validate(ghost, &known()).unwrap_err().contains("not a page"));

    let mut nan = default_doc();
    nan.positions.insert("/".into(), FlowPosition { x: f64::NAN, y: 0.0 });
    assert!(validate(nan, &known()).unwrap_err().contains("finite"));
}

#[test]
fn filter_to_known_drops_edges_and_positions_touching_a_gone_page() {
    let mut d = with_edges(vec![
        edge("e1", "/", "/login", None),
        edge("e2", "/gone", "/", None),
        edge("e3", "/signup", "/gone", None),
    ]);
    d.positions.insert("/".into(), FlowPosition { x: 1.0, y: 2.0 });
    d.positions.insert("/gone".into(), FlowPosition { x: 3.0, y: 4.0 });
    let out = filter_to_known(d, &known());
    assert_eq!(out.edges, vec![edge("e1", "/", "/login", None)]);
    assert_eq!(out.positions.len(), 1);
    assert!(out.positions.contains_key("/"));
    // And the filtered document is writable, which is what keeps a trashed page
    // from wedging every later write.
    validate(out, &known()).expect("the served document validates");
}

#[test]
fn link_pages_mints_a_unique_id_and_refuses_bad_links() {
    let (d, id) = link_pages(default_doc(), &known(), "/", "/login", Some("existing user")).unwrap();
    assert_eq!(id, "e1", "the first link in a document is e1");
    assert_eq!(d.edges, vec![edge(&id, "/", "/login", Some("existing user"))]);

    let (d2, id2) = link_pages(d.clone(), &known(), "/", "/signup", None).unwrap();
    assert_eq!(id2, "e2");
    assert_eq!(d2.edges.len(), 2);

    assert!(link_pages(d.clone(), &known(), "/", "/login", None).unwrap_err().contains("already links"));
    assert!(link_pages(d.clone(), &known(), "/", "/", None).unwrap_err().contains("itself"));
    assert!(link_pages(d, &known(), "/", "/nope", None).unwrap_err().contains("not a page"));
}

#[test]
fn unlink_update_and_find_edge() {
    let d = with_edges(vec![edge("e1", "/", "/login", Some("a")), edge("e2", "/", "/signup", None)]);
    assert_eq!(find_edge(&d, Some("e2"), None, None).unwrap(), "e2");
    assert_eq!(find_edge(&d, None, Some("/"), Some("/login")).unwrap(), "e1");
    assert!(find_edge(&d, Some("nope"), None, None).is_err());
    assert!(find_edge(&d, None, Some("/login"), Some("/")).is_err(), "edges are directed");
    assert!(find_edge(&d, Some("e1"), Some("/"), Some("/login")).is_err(), "one way, not both");
    assert!(find_edge(&d, None, Some("/"), None).is_err());

    let relabelled = update_link(d.clone(), "e2", Some("new user")).unwrap();
    assert_eq!(relabelled.edges[1].label.as_deref(), Some("new user"));
    let cleared = update_link(relabelled, "e2", None).unwrap();
    assert_eq!(cleared.edges[1].label, None);
    assert!(update_link(d.clone(), "ghost", None).is_err());

    let removed = unlink_pages(d.clone(), "e1").unwrap();
    assert_eq!(removed.edges, vec![edge("e2", "/", "/signup", None)]);
    assert!(unlink_pages(d, "ghost").unwrap_err().contains("no flow link"));
}

#[test]
fn set_position_pins_a_known_page_only() {
    let d = set_position(default_doc(), &known(), "/login", 100.0, 200.0).unwrap();
    assert_eq!(d.positions["/login"], FlowPosition { x: 100.0, y: 200.0 });
    let moved = set_position(d, &known(), "/login", -5.0, 7.5).unwrap();
    assert_eq!(moved.positions["/login"], FlowPosition { x: -5.0, y: 7.5 });
    assert!(set_position(default_doc(), &known(), "/nope", 0.0, 0.0).is_err());
}

#[test]
fn edge_ids_are_e_then_one_past_the_largest_numeric_suffix() {
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(mint_edge_id(&[]), "e1");
    assert_eq!(mint_edge_id(&ids(&["e1", "e2"])), "e3");
    assert_eq!(mint_edge_id(&ids(&["e7", "e2"])), "e8", "the max, not the count");
    // Ids of another spelling (a hand-built or legacy one) are ignored.
    assert_eq!(mint_edge_id(&ids(&["eabc", "x9", "e", "e-4", "e3x"])), "e1");
    assert_eq!(mint_edge_id(&ids(&["e009", "gfoo"])), "e10");
}
