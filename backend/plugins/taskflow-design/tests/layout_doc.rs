use std::collections::HashMap;

use taskflow_design::layout_doc::{
    default_doc, filter_to_known, page_name, panel_sections, parse, resolve_route_order,
    to_json_string, to_value, validate, LayoutDoc, LayoutGroup, MAX_GROUPS, MAX_LABEL,
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

fn doc(view: DesignView, groups: Vec<LayoutGroup>) -> LayoutDoc {
    LayoutDoc { view, route_order: vec!["/".into()], groups, page_labels: HashMap::new() }
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
        page_labels: HashMap::new(),
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
        page_labels: HashMap::new(),
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
        page_labels: HashMap::new(),
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
        page_labels: HashMap::new(),
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
