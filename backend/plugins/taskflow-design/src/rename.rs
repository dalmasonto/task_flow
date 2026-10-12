//! #682: renaming a page's ROUTE — the whole change, not the file move.
//!
//! A route is a page file's PATH (`pages/ai-coach.html` → `/ai-coach`), so
//! renaming one is a page write. But a route is also a NAME that other things
//! point at, and moving the file alone would leave every one of those pointing
//! at a route nobody serves:
//!
//! - **Links inside other pages** (`<a href="/ai-coach">`) — what a reader
//!   clicks is one of those, so the fragments are rewritten here rather than
//!   left to fail, one page write each (validated, versioned, recorded — an
//!   accidental shape gets refused by the same validator as any edit).
//! - **The arrangement** — flow order, group membership, the page's label,
//!   both ends of every arrow, and its pinned Flow position. That half is
//!   `layout_doc::rename_route`, pure and tested there.
//!
//! The old page goes to the TRASH rather than being deleted: a rename is a
//! guess about what the owner meant, and the history plus the trash are what
//! make a wrong guess cheap. Nothing here runs piecemeal — one project lock
//! covers the move, the link rewrites and the arrangement update, and the
//! response says exactly what changed.

use umbral_realtime::Realtime;

use crate::layout_doc::LayoutDoc;
use crate::manifest;
use crate::models::{DesignFileKind, DesignLayout, design_layout};
use crate::store;

/// Why a rename was refused. Every arm is a 4xx with its own message.
#[derive(Debug)]
pub enum RenameError {
    /// A route that cannot name a page (nested, illegal characters).
    BadRoute(String),
    /// Both arguments name the SAME page file.
    SamePage,
    /// No live page serves `from`.
    NoSuchPage(String),
    /// Something already serves `to`. A rename never overwrites.
    TargetExists(String),
    /// A TRASHED page holds `to` — a write there would purge it for good,
    /// which is a deletion nobody asked for.
    TargetInTrash(String),
    /// A write inside the rename was refused by the shared validator: the
    /// whole rename is abandoned, and what already landed is reported.
    Rejected { path: String, message: String },
}

/// What a rename did.
#[derive(Debug, serde::Serialize)]
pub struct RenameReport {
    pub from: String,
    pub to: String,
    pub from_path: String,
    pub to_path: String,
    /// Pages whose fragments were rewritten (their links to the old route).
    pub pages_rewritten: Vec<String>,
    /// Pages that mentioned the old route but could not be rewritten (a
    /// concurrent edit won the lock first); they now point at a missing route
    /// and are named rather than hidden.
    pub pages_skipped: Vec<String>,
    /// Whether the arrangement followed (it always does when it parses).
    pub layout_updated: bool,
}

/// Rewrite `href` values that name `from` so they name `to`, returning the new
/// content and how many were rewritten.
///
/// Only `href` attributes are touched: an `src`, a `data-*` or a bare string
/// that happens to look like the route is not a link, and rewriting it would
/// be guessing. The value must be the route EXACTLY, optionally with a
/// trailing slash and then a `#fragment` or `?query` — `/ai-coaching` is a
/// different route and stays as it is.
pub fn rewrite_hrefs(content: &str, from: &str, to: &str) -> (String, usize) {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    let mut count = 0;
    while let Some(position) = rest.find("href=") {
        let (before, after) = rest.split_at(position + "href=".len());
        out.push_str(before);
        let mut chars = after.char_indices();
        match chars.next() {
            Some((_, quote @ ('"' | '\''))) => {
                let body = &after[quote.len_utf8()..];
                let end = body.find(quote).unwrap_or(body.len());
                let value = &body[..end];
                match retarget(value, from, to) {
                    Some(next) => {
                        count += 1;
                        out.push(quote);
                        out.push_str(&next);
                    }
                    None => {
                        out.push(quote);
                        out.push_str(value);
                    }
                }
                out.push(quote);
                let consumed = quote.len_utf8() + end + quote.len_utf8();
                rest = &after[consumed.min(after.len())..];
            }
            // `href=` followed by anything but a quote (unquoted attributes
            // are legal HTML and this scanner does not claim to read them):
            // copy the token and move on rather than guess.
            _ => rest = after,
        }
    }
    out.push_str(rest);
    (out, count)
}

/// The new value for one href, or `None` when it does not name `from`.
fn retarget(value: &str, from: &str, to: &str) -> Option<String> {
    let rest = value.strip_prefix(from)?;
    // `/` is a prefix of every route, so the root route only matches itself
    // (plus a fragment/query); every other route also admits a trailing slash.
    let allowed = if from == "/" {
        rest.is_empty() || rest.starts_with('#') || rest.starts_with('?')
    } else {
        rest.is_empty() || rest.starts_with('/') || rest.starts_with('#') || rest.starts_with('?')
    };
    allowed.then(|| format!("{to}{rest}"))
}

/// Rename `from` → `to` in one project, in one lock. See the module docs.
///
/// MUST be called with the project lock already held (`views::project_locks`)
/// — it performs several store writes and none of them may interleave with
/// another writer's.
pub async fn rename_route(
    project_id: i64,
    from: &str,
    to: &str,
    by: &str,
) -> Result<RenameReport, RenameError> {
    let from_route = normalize_route(from);
    let to_route = normalize_route(to);
    let from_path = manifest::page_path_for_route(&from_route)
        .ok_or_else(|| RenameError::BadRoute(from.to_string()))?;
    let to_path = manifest::page_path_for_route(&to_route)
        .ok_or_else(|| RenameError::BadRoute(to.to_string()))?;
    if from_path == to_path {
        return Err(RenameError::SamePage);
    }

    let files = store::list_files(project_id).await;
    let Some(source) = files.iter().find(|f| f.path == from_path) else {
        return Err(RenameError::NoSuchPage(from_route));
    };
    if files.iter().any(|f| f.path == to_path) {
        return Err(RenameError::TargetExists(to_route));
    }
    if store::list_trashed(project_id).await.iter().any(|f| f.path == to_path) {
        return Err(RenameError::TargetInTrash(to_route));
    }
    let content = source.content.clone();

    // Everything the realtime feed must hear about, in one place: viewers
    // remount exactly the boards this rename touched.
    let mut events: Vec<(String, i64, String, i64, Vec<String>)> = Vec::new(); // (action, id, path, version, routes)

    // 1. The new page, content unchanged — the same validator every write
    //    meets, so a rename cannot smuggle a fragment past any rule.
    match store::write_file(project_id, &to_path, &content, None, by).await {
        store::WriteOutcome::Saved(row, _) => {
            events.push(("created".into(), row.id, row.path.clone(), row.version, vec![to_route.clone()]));
        }
        store::WriteOutcome::Rejected(verdict) => {
            return Err(RenameError::Rejected {
                path: to_path,
                message: verdict
                    .errors
                    .first()
                    .map(|err| err.message.clone())
                    .unwrap_or_else(|| "the page was refused".to_string()),
            });
        }
        store::WriteOutcome::Conflict(_) => {
            return Err(RenameError::TargetExists(to_route));
        }
    }

    // 2. The old page leaves — to the TRASH, so a wrong rename is restorable.
    if let Some((id, version)) = store::trash_file(project_id, &from_path).await {
        events.push(("deleted".into(), id, from_path.clone(), version, vec![from_route.clone()]));
    }

    // 3. Every OTHER page that links to the old route.
    let mut pages_rewritten = Vec::new();
    let mut pages_skipped = Vec::new();
    for page in files
        .iter()
        .filter(|f| f.kind == DesignFileKind::Page && f.path != from_path && f.path != to_path)
    {
        let (next, count) = rewrite_hrefs(&page.content, &from_route, &to_route);
        if count == 0 {
            continue;
        }
        // Base-versioned: the snapshot this loop read is what gets rewritten,
        // so a page someone else edited mid-rename is SKIPPED (and named in
        // the response), never clobbered.
        match store::write_file(project_id, &page.path, &next, Some(page.version), by).await {
            store::WriteOutcome::Saved(row, _) => {
                let route = manifest::route_for_page(&row.path).into_iter().collect();
                events.push(("updated".into(), row.id, row.path.clone(), row.version, route));
                pages_rewritten.push(page.path.clone());
            }
            _ => pages_skipped.push(page.path.clone()),
        }
    }

    // 4. The arrangement: flow order, groups, the label, arrows, position.
    let layout_updated = rename_layout(project_id, &from_route, &to_route).await;

    // 5. Tell every viewer, one event per file, in the widened shape the
    //    canvas scopes its remounts by. (The arrangement has its own group.)
    for (action, id, path, version, routes) in events {
        crate::signals::emit_file_event(project_id, &action, id, &path, version, routes).await;
    }
    if layout_updated {
        let version = DesignLayout::objects()
            .filter(design_layout::PROJECT.eq(project_id))
            .first()
            .await
            .ok()
            .flatten()
            .map(|row| row.version)
            .unwrap_or(0);
        Realtime::to_group(crate::signals::layout_group(project_id))
            .send("updated", &serde_json::json!({ "id": version }))
            .await;
    }

    Ok(RenameReport {
        from: from_route,
        to: to_route,
        from_path,
        to_path,
        pages_rewritten,
        pages_skipped,
        layout_updated,
    })
}

/// `/x/` → `/x`, `/` → `/`: the stored form of a route.
fn normalize_route(route: &str) -> String {
    let trimmed = route.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Move every reference in the arrangement, then store it. A document that
/// will not parse is left alone rather than replaced by a guess — the same
/// rule `write_layout` follows.
async fn rename_layout(project_id: i64, from: &str, to: &str) -> bool {
    let existing = DesignLayout::objects()
        .filter(design_layout::PROJECT.eq(project_id))
        .first()
        .await
        .ok()
        .flatten();
    let Some(row) = existing else {
        return false; // no arrangement saved yet: nothing to move
    };
    let Ok(doc) = crate::layout_doc::parse(&row.layout_json) else {
        eprintln!("design rename: the stored arrangement will not parse; left as is");
        return false;
    };
    let next: LayoutDoc = crate::layout_doc::rename_route(doc, from, to);
    let json = crate::layout_doc::to_json_string(&next);
    DesignLayout::objects()
        .filter(design_layout::ID.eq(row.id) & design_layout::VERSION.eq(row.version))
        .update_values(
            serde_json::json!({ "layout_json": json, "version": row.version + 1, "updated_by": "rename" })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        )
        .await
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_only_the_exact_route_in_hrefs() {
        let content = r#"<a href="/ai-coach">go</a><a href="/ai-coaching">other</a><a href="https://x.test/ai-coach">ext</a>"#;
        let (next, count) = rewrite_hrefs(content, "/ai-coach", "/pulse");
        assert_eq!(count, 1);
        assert!(next.contains(r#"href="/pulse""#), "{next}");
        assert!(next.contains(r#"href="/ai-coaching""#), "a longer route is not a match: {next}");
        assert!(next.contains(r#"href="https://x.test/ai-coach""#), "a URL is not a path: {next}");
    }

    #[test]
    fn keeps_a_trailing_slash_and_a_fragment() {
        let (next, count) = rewrite_hrefs(r#"<a href='/ai-coach/'>x</a><a href="/ai-coach#top">y</a>"#, "/ai-coach", "/pulse");
        assert_eq!(count, 2);
        assert!(next.contains("href='/pulse/'"), "{next}");
        assert!(next.contains(r#"href="/pulse#top""#), "{next}");
    }

    #[test]
    fn the_root_route_only_matches_itself() {
        let content = r#"<a href="/">home</a><a href="/pricing">pricing</a>"#;
        let (next, count) = rewrite_hrefs(content, "/", "/home");
        assert_eq!(count, 1, "every route starts with / — only the bare one may match: {next}");
        assert!(next.contains(r#"href="/home""#));
        assert!(next.contains(r#"href="/pricing""#));
    }

    #[test]
    fn ignores_other_attributes_and_unquoted_values() {
        let content = r#"<img src="/ai-coach.png"><a href="/ai-coach">go</a>"#;
        let (next, count) = rewrite_hrefs(content, "/ai-coach", "/pulse");
        assert_eq!(count, 1);
        assert!(next.contains(r#"src="/ai-coach.png""#), "src is not a link: {next}");
    }

    #[test]
    fn normalizes_routes() {
        assert_eq!(normalize_route("/x/"), "/x");
        assert_eq!(normalize_route("x"), "/x");
        assert_eq!(normalize_route("/"), "/");
        assert_eq!(normalize_route("  "), "/");
    }
}
