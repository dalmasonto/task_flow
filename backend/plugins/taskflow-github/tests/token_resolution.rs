use taskflow_github::tokens::{
    FakeTokenSource, TokenOutcome, resolve_actor_token, resolve_owner_token,
};

fn ready(o: TokenOutcome) -> Option<String> {
    match o {
        TokenOutcome::Ready(t) => Some(t),
        TokenOutcome::NeedsConnect => None,
    }
}

#[tokio::test]
async fn owner_token_needs_connect_when_no_linker() {
    let src = FakeTokenSource::new();
    assert!(matches!(resolve_owner_token(&src, None).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn owner_token_ready_when_linker_has_token() {
    let src = FakeTokenSource::new().with(7, "owner-tok");
    assert_eq!(ready(resolve_owner_token(&src, Some(7)).await), Some("owner-tok".into()));
}

#[tokio::test]
async fn owner_token_needs_connect_when_linker_unlinked() {
    let src = FakeTokenSource::new(); // user 7 has no SocialAccount
    assert!(matches!(resolve_owner_token(&src, Some(7)).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_needs_connect_when_opted_out() {
    let src = FakeTokenSource::new().with(3, "actor-tok");
    assert!(matches!(resolve_actor_token(&src, 3, false).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_needs_connect_when_opted_in_but_unlinked() {
    let src = FakeTokenSource::new();
    assert!(matches!(resolve_actor_token(&src, 3, true).await, TokenOutcome::NeedsConnect));
}

#[tokio::test]
async fn actor_token_ready_when_opted_in_and_linked() {
    let src = FakeTokenSource::new().with(3, "actor-tok");
    assert_eq!(ready(resolve_actor_token(&src, 3, true).await), Some("actor-tok".into()));
}
