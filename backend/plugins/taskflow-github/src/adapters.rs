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

    async fn current_login(&self, token: &str) -> Result<String, GithubError> {
        let resp = self
            .client
            .get("https://api.github.com/user")
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .send()
            .await
            .map_err(|_| GithubError::Other("github /user request failed".into()))?;
        match resp.status().as_u16() {
            200 => {
                let v: serde_json::Value = resp.json().await.map_err(|_| GithubError::Other("github /user body".into()))?;
                v["login"].as_str().map(str::to_string).ok_or_else(|| GithubError::Other("github /user had no login".into()))
            }
            401 => Err(GithubError::Unauthorized),
            s => Err(GithubError::Other(format!("github {s}"))),
        }
    }

    async fn revoke_token(&self, token: &str) -> Result<(), GithubError> {
        // The app credentials umbral-oauth's GitHubProvider::from_env reads.
        let (Ok(id), Ok(secret)) = (std::env::var("UMBRAL_OAUTH_GITHUB_CLIENT_ID"), std::env::var("UMBRAL_OAUTH_GITHUB_CLIENT_SECRET")) else {
            return Ok(());
        };
        let resp = self
            .client
            .delete(format!("https://api.github.com/applications/{id}/token"))
            .basic_auth(id, Some(secret))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "taskflow")
            .json(&json!({ "access_token": token }))
            .send()
            .await
            .map_err(|_| GithubError::Other("github revoke request failed".into()))?;
        match resp.status().as_u16() {
            204 | 404 => Ok(()),
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

    async fn account_for_user(&self, user_id: i64) -> Option<crate::tokens::AccountInfo> {
        use umbral_oauth::models::{SocialAccount, social_account};
        let account = SocialAccount::objects()
            .filter(social_account::USER.eq(user_id) & social_account::PROVIDER.eq("github"))
            .first()
            .await
            .ok()??;
        Some(crate::tokens::AccountInfo { connected_at: Some(account.created_at), scopes: account.scopes, account_id: account.provider_uid })
    }

    async fn disconnect(&self, user_id: i64) -> Option<String> {
        use umbral_oauth::models::{SocialAccount, social_account};
        let filter = social_account::USER.eq(user_id) & social_account::PROVIDER.eq("github");
        let account = SocialAccount::objects().filter(filter.clone()).first().await.ok()??;
        let token = account.access_token.reveal().ok();
        SocialAccount::objects().filter(filter).delete().await.ok()?;
        token.or(Some(String::new()))
    }
}
