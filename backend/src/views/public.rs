//! Public storefront views — anyone can hit these, no auth required.
//!
//! Every handler returns `Result<_, ApiError>` and lets `?` do the work. `ApiError`
//! converts from a database error, a `WriteError` and a template error, so there is no
//! per-handler error helper to write — and a 500 logs the real cause server-side while
//! the client gets an opaque message. Never hand `err.to_string()` to a browser: that is
//! how table names and SQL fragments end up on someone else's screen.

use umbral::prelude::*;
use umbral::templates::context;

use crate::Post;
use crate::post;

/// Home page. Counts published posts and renders home.html.
pub async fn home() -> Result<Html<String>, ApiError> {
    let post_count = Post::objects()
        .filter(post::PUBLISHED.eq(true))
        .count()
        .await?;

    let body = umbral::templates::render("home.html", &context!(post_count))?;
    Ok(Html(body))
}

/// JSON list of all posts — demonstrates the ORM QuerySet.
pub async fn api_list_posts() -> Result<Json<Vec<Post>>, ApiError> {
    let posts = Post::objects().order_by(post::ID.desc()).fetch().await?;
    Ok(Json(posts))
}

/// Dashboard: only reachable when logged in (see the `login_required_html`
/// layer in `main.rs`). The `LoggedIn<AuthUser>` extractor supplies the
/// current user — the layer already checked the session, so this is a
/// cheap field read, not a second DB query.
pub async fn dashboard(
    user: umbral_auth::LoggedIn<umbral_auth::AuthUser>,
) -> Result<Html<String>, ApiError> {
    // Demonstrates a transaction: fetch the user's post list atomically.
    let user_id = user.id;
    let my_posts = umbral::transaction(|tx| {
        Box::pin(async move {
            Post::objects()
                .filter(post::AUTHOR.eq(user_id))
                .on_tx(tx)
                .fetch()
                .await
        })
    })
    .await?;

    let body = umbral::templates::render("dashboard.html", &context!(user, my_posts))?;
    Ok(Html(body))
}
