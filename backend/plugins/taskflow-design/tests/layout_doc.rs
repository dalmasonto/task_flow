use taskflow_design::layout_doc::{
    default_doc, filter_to_known, parse, to_json_string, to_value, validate, LayoutDoc, LayoutGroup,
    MAX_GROUPS,
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
    LayoutDoc { view, route_order: vec!["/".into()], groups }
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
