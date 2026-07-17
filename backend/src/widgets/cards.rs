//! Dashboard widget builders. This starter re-exports one framework
//! builtin so a fresh `/admin/` dashboard isn't empty; replace it with
//! your own KPI tiles as the app grows.
//!
//! A widget is a `Widget` value handed to `WidgetSection::widget(...)`.
//! Each section becomes one row of tiles on the admin dashboard. See
//! `documentation/docs/v0.0.1/admin/` and the `examples/shop/src/widgets`
//! reference for the data-closure pattern that hits the ORM.

use umbral_admin::WidgetSection;

/// One dashboard section wiring two framework builtins: a model-count
/// tile and a recent-users list. Mounted from `main.rs` via
/// `.dashboard_section(widgets::cards::overview_section())`.
pub fn overview_section() -> WidgetSection {
    WidgetSection::new("Overview")
        .subtitle("Framework-wide health + recent activity")
        .widget(umbral_admin::builtin_total_models_widget().with_span(8, 2))
        .widget(umbral_admin::builtin_recent_users_widget().with_span(4, 2))
}
