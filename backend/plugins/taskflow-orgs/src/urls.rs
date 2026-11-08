//! URL conf for the `taskflow-orgs` plugin. See `views.rs` for who may call what.

use umbral::web::{Router, get, post};

use crate::views;

pub fn router() -> Router {
    Router::new()
        .route("/api/taskflow/orgs", get(views::my_orgs))
        .route("/api/taskflow/orgs/{org}", get(views::get_org).patch(views::patch_org))
        .route("/api/taskflow/orgs/{org}/members", get(views::list_members))
        .route(
            "/api/taskflow/orgs/{org}/members/{user}",
            umbral::web::patch(views::set_role).delete(views::remove_member),
        )
        .route("/api/taskflow/orgs/{org}/invites", get(views::list_invites).post(views::create_invite))
        .route("/api/taskflow/orgs/{org}/invites/{id}", umbral::web::delete(views::revoke_invite))
        .route("/api/taskflow/orgs/{org}/invites/{id}/resend", post(views::resend_invite))
        .route("/api/taskflow/org-invites/accept", post(views::accept_invite))
        .route("/api/taskflow/org-invites/peek", post(views::peek_invite))
}
