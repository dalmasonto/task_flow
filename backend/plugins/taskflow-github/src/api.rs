//! The GitHub API boundary. Everything outbound goes through `GithubApi`, so
//! handlers are testable against `FakeGithubApi` with no network.

use std::sync::Mutex;

use async_trait::async_trait;

#[derive(Debug, Clone)]
pub struct NewIssue {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct IssueRef {
    pub number: i64,
    pub url: String,
}

#[derive(Debug)]
pub enum GithubError {
    Unauthorized,
    NotFound,
    Other(String),
}

#[async_trait]
pub trait GithubApi: Send + Sync {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError>;

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError>;
}

/// In-memory test double: records every call, returns a scripted issue ref.
pub struct FakeGithubApi {
    ref_number: i64,
    ref_url: String,
    created: Mutex<Vec<(String, String, NewIssue)>>,
    comments: Mutex<Vec<(String, String, i64, String)>>,
}

impl FakeGithubApi {
    pub fn returning(number: i64, url: &str) -> Self {
        Self {
            ref_number: number,
            ref_url: url.to_string(),
            created: Mutex::new(Vec::new()),
            comments: Mutex::new(Vec::new()),
        }
    }
    pub fn created_issues(&self) -> Vec<(String, String, NewIssue)> {
        self.created.lock().unwrap().clone()
    }
    pub fn comments(&self) -> Vec<(String, String, i64, String)> {
        self.comments.lock().unwrap().clone()
    }
}

#[async_trait]
impl GithubApi for FakeGithubApi {
    async fn create_issue(
        &self,
        token: &str,
        repo: &str,
        issue: NewIssue,
    ) -> Result<IssueRef, GithubError> {
        self.created
            .lock()
            .unwrap()
            .push((token.to_string(), repo.to_string(), issue));
        Ok(IssueRef { number: self.ref_number, url: self.ref_url.clone() })
    }

    async fn add_comment(
        &self,
        token: &str,
        repo: &str,
        issue_number: i64,
        body: &str,
    ) -> Result<(), GithubError> {
        self.comments.lock().unwrap().push((
            token.to_string(),
            repo.to_string(),
            issue_number,
            body.to_string(),
        ));
        Ok(())
    }
}
