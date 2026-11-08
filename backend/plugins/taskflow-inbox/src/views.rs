//! #1116: inbox handlers. Human-only: an inbox is a person's.

use umbral::prelude::IntoResponse;
use umbral::web::{Json, Query, Response};
use umbral_auth::RequireAuth;

use crate::service::{self, ApiError, InboxQuery};

pub async fn inbox(RequireAuth(user): RequireAuth<i64>, Query(q): Query<InboxQuery>) -> Result<Response, ApiError> {
    Ok(Json(service::inbox(user, &q).await?).into_response())
}

pub async fn mark_read(RequireAuth(user): RequireAuth<i64>) -> Result<Response, ApiError> {
    Ok(Json(service::mark_read(user).await?).into_response())
}
