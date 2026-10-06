//! The built-in shadcn **neutral** theme, merged UNDER every project's tokens at
//! serve/compose time (never written to storage). A project token wins in full;
//! a name the project lacks comes from here. Matching is by EMITTED variable
//! name, so a legacy import's `custom["--primary"]` shadows `colors.primary`.
//! Values: shadcn/ui neutral base colour (oklch), radius 0.625rem.

use crate::tokens::{category_to_var_name, OrderedMap, TokenValue, TokensDoc};
use std::collections::HashSet;

const COLORS: &[(&str, &str, &str)] = &[
    ("background", "oklch(1 0 0)", "oklch(0.145 0 0)"),
    ("foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("card", "oklch(1 0 0)", "oklch(0.205 0 0)"),
    ("card-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("popover", "oklch(1 0 0)", "oklch(0.205 0 0)"),
    ("popover-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("primary", "oklch(0.205 0 0)", "oklch(0.922 0 0)"),
    ("primary-foreground", "oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    ("secondary", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("secondary-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("muted", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("muted-foreground", "oklch(0.556 0 0)", "oklch(0.708 0 0)"),
    ("accent", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("accent-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("destructive", "oklch(0.577 0.245 27.325)", "oklch(0.704 0.191 22.216)"),
    ("border", "oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    ("input", "oklch(0.922 0 0)", "oklch(1 0 0 / 15%)"),
    ("ring", "oklch(0.708 0 0)", "oklch(0.556 0 0)"),
    ("chart-1", "oklch(0.646 0.222 41.116)", "oklch(0.488 0.243 264.376)"),
    ("chart-2", "oklch(0.6 0.118 184.704)", "oklch(0.696 0.17 162.48)"),
    ("chart-3", "oklch(0.398 0.07 227.392)", "oklch(0.769 0.188 70.08)"),
    ("chart-4", "oklch(0.828 0.189 84.429)", "oklch(0.627 0.265 296.677)"),
    ("chart-5", "oklch(0.769 0.188 70.08)", "oklch(0.645 0.246 16.439)"),
    ("sidebar", "oklch(0.985 0 0)", "oklch(0.205 0 0)"),
    ("sidebar-foreground", "oklch(0.145 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-primary", "oklch(0.205 0 0)", "oklch(0.488 0.243 264.376)"),
    ("sidebar-primary-foreground", "oklch(0.985 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-accent", "oklch(0.97 0 0)", "oklch(0.269 0 0)"),
    ("sidebar-accent-foreground", "oklch(0.205 0 0)", "oklch(0.985 0 0)"),
    ("sidebar-border", "oklch(0.922 0 0)", "oklch(1 0 0 / 10%)"),
    ("sidebar-ring", "oklch(0.708 0 0)", "oklch(0.556 0 0)"),
];

/// The shadcn neutral theme as a token document.
pub fn shadcn_defaults() -> TokensDoc {
    let mut colors = OrderedMap::new();
    for (key, light, dark) in COLORS {
        colors.insert(*key, TokenValue { light: (*light).into(), dark: Some((*dark).into()) });
    }
    let mut custom = OrderedMap::new();
    custom.insert("radius", TokenValue { light: "0.625rem".into(), dark: None });
    let mut categories = OrderedMap::new();
    categories.insert("colors", colors);
    categories.insert("custom", custom);
    TokensDoc { version: 1, categories }
}

/// Every emitted `--var` name a document defines.
fn var_names(doc: &TokensDoc) -> HashSet<String> {
    doc.categories
        .iter()
        .flat_map(|(cat, toks)| toks.iter().map(move |(k, _)| category_to_var_name(cat, k)))
        .collect()
}

/// The defaults the project does not define (by emitted var name).
pub fn missing_defaults(project: &TokensDoc) -> TokensDoc {
    let have = var_names(project);
    let mut out = TokensDoc::default();
    for (cat, toks) in shadcn_defaults().categories.iter() {
        for (key, value) in toks.iter() {
            if !have.contains(&category_to_var_name(cat, key)) {
                out.categories
                    .entry_or_insert_with(cat, OrderedMap::new)
                    .insert(key.clone(), value.clone());
            }
        }
    }
    out
}

/// `project` with every missing default appended — what pages render with.
pub fn effective_tokens(project: &TokensDoc) -> TokensDoc {
    let mut out = project.clone();
    for (cat, toks) in missing_defaults(project).categories.iter() {
        let target = out.categories.entry_or_insert_with(cat, OrderedMap::new);
        for (key, value) in toks.iter() {
            target.insert(key.clone(), value.clone());
        }
    }
    out
}

/// The shadcn colour names, for the bridge: these vars always exist in an
/// effective doc (from the project under any category, or from the defaults).
pub fn default_color_names() -> impl Iterator<Item = &'static str> {
    COLORS.iter().map(|(k, _, _)| *k)
}
