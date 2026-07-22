use taskflow_github::api::{FakeGithubApi, GithubApi, NewIssue};

#[tokio::test]
async fn fake_records_issue_creation_and_returns_scripted_ref() {
    let api = FakeGithubApi::returning(42, "https://github.com/acme/widgets/issues/42");
    let issue = api
        .create_issue("tok", "acme/widgets", NewIssue { title: "T".into(), body: "B".into() })
        .await
        .expect("create");
    assert_eq!(issue.number, 42);
    let calls = api.created_issues();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "tok");
    assert_eq!(calls[0].1, "acme/widgets");
    assert_eq!(calls[0].2.title, "T");
}
