//! Real adapters: GitHub REST via reqwest, tokens via umbral-oauth.
//!
//! This is the only module that names `reqwest` or `umbral-oauth`. Everything
//! else in the plugin is written against the `GithubApi` / `GithubTokenSource`
//! traits and tested with fakes.

use async_trait::async_trait;
use serde_json::json;

use crate::api::{GithubApi, GithubError, IssueRef, NewIssue};
use crate::tokens::GithubTokenSource;

/// GitHub REST v3 client. Auth via `Authorization: Bearer <token>`.
pub struct ReqwestGithubApi {
    client: reqwest::Client,
}
impl ReqwestGithubApi {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}
impl Default for ReqwestGithubApi {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl GithubApi for ReqwestGithubApi {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError> {
        let resp = self
            .client
            .post(format!("https://api.github.com/repos/{repo}/issues"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .json(&json!({ "title": issue.title, "body": issue.body }))
            .send()
            .await
            .map_err(|e| GithubError::Other(e.to_string()))?;
        match resp.status().as_u16() {
            201 => {
                let v: serde_json::Value =
                    resp.json().await.map_err(|e| GithubError::Other(e.to_string()))?;
                Ok(IssueRef {
                    number: v["number"]
                        .as_i64()
                        .ok_or_else(|| GithubError::Other("issue response had no number".into()))?,
                    url: v["html_url"].as_str().unwrap_or_default().to_string(),
                })
            }
            401 => Err(GithubError::Unauthorized),
            404 => Err(GithubError::NotFound),
            s => Err(GithubError::Other(format!("github {s}"))),
        }
    }

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError> {
        let resp = self
            .client
            .post(format!(
                "https://api.github.com/repos/{repo}/issues/{issue_number}/comments"
            ))
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .json(&json!({ "body": body }))
            .send()
            .await
            .map_err(|e| GithubError::Other(e.to_string()))?;
        match resp.status().as_u16() {
            201 => Ok(()),
            401 => Err(GithubError::Unauthorized),
            404 => Err(GithubError::NotFound),
            s => Err(GithubError::Other(format!("github {s}"))),
        }
    }
}

/// Reads a user's linked GitHub token from their `SocialAccount`. An expired
/// token is treated as "not linked" so the UI routes the user back through
/// connect instead of hitting a 401.
pub struct OauthTokenSource;

#[async_trait]
impl GithubTokenSource for OauthTokenSource {
    async fn token_for_user(&self, user_id: i64) -> Option<String> {
        use umbral_oauth::models::{SocialAccount, social_account};
        let account = SocialAccount::objects()
            .filter(social_account::USER.eq(user_id) & social_account::PROVIDER.eq("github"))
            .first()
            .await
            .ok()??;
        if let Some(expires_at) = account.expires_at {
            if expires_at < chrono::Utc::now() {
                return None;
            }
        }
        account.access_token.reveal().ok()
    }
}
