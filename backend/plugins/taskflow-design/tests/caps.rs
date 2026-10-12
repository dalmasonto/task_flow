//! The per-project caps at scale — #665 raised the budget from 200 files /
//! 4 MiB to 500 files / 16 MiB, because the owner's projects are expected to
//! hold ~500 boards, and 500 files × ~8 KB first overruns the BYTE cap, not
//! the file count. These tests pin both ceilings at their post-change values
//! and, just as importantly, that the caps are still real: a raise that
//! removed the check would pass a test that only asserts "the 500th file is
//! accepted", so each raise is asserted from both sides.
//!
//! The NUMBERS below are literals, deliberately — not
//! `validation::MAX_FILES_PER_PROJECT`. A test parameterized by the constant
//! it exists to change moves with the constant and can never fail: seeding
//! "cap - 1" rows proves nothing about the cap being 500. The requirement is
//! the number, so the test states the number, and the constants are asserted
//! against it at the top.

mod support;

use serde_json::json;
use support::TestApp;
use umbral::orm::ForeignKey;

use taskflow_design::models::{DesignFile, DesignFileKind};
use taskflow_design::validation::{MAX_FILES_PER_PROJECT, MAX_FILE_BYTES, MAX_PROJECT_BYTES};

/// #665: the caps the rest of this file pins. Must match the constants — a
/// change to either without the other is exactly what this line catches.
#[test]
fn the_caps_are_five_hundred_files_and_sixteen_mib() {
    assert_eq!(MAX_FILES_PER_PROJECT, 500);
    assert_eq!(MAX_PROJECT_BYTES, 16 * 1024 * 1024);
    assert_eq!(MAX_FILE_BYTES, 128 * 1024, "the per-file cap stays put");
}

/// Seed `n` filler files directly through the ORM.
///
/// Deliberately not through the write route: the caps count ROWS, so the
/// fixtures only need to exist, and validating 499 filler pages would test the
/// validator five hundred times over to set up one assertion about a counter.
/// The filler content is arbitrary for the same reason — a row's bytes count
/// whether or not its fragment would pass.
async fn seed_files(project: i64, n: usize, bytes_each: usize) {
    let content = "x".repeat(bytes_each);
    for i in 0..n {
        DesignFile::objects()
            .create(DesignFile {
                id: 0,
                project: ForeignKey::new(project),
                kind: DesignFileKind::Page,
                path: format!("pages/seed-{i}.html"),
                content: content.clone(),
                version: 1,
                updated_by: "test".into(),
                created_at: None,
                updated_at: None,
                deleted_at: None,
            })
            .await
            .expect("seed a filler file");
    }
}

async fn put_page(app: &TestApp, user: i64, project: i64, path: &str, content: &str) -> support::TestResponse {
    app.put_json_as(
        user,
        &format!("/api/design/{project}/file"),
        &json!({ "path": path, "content": content }),
    )
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_file_count_cap_admits_the_500th_file_and_refuses_the_501st() {
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    // One short of 500: the NEXT new file is the one that must still fit.
    seed_files(project, 499, 8).await;

    let fits = put_page(&app, user.id, project, "pages/final.html", "<p>fits</p>").await;
    assert_eq!(
        fits.status(),
        201,
        "the 500th file must be accepted: {}",
        fits.text()
    );

    let refused = put_page(&app, user.id, project, "pages/one-more.html", "<p>over</p>").await;
    assert_eq!(
        refused.status(),
        422,
        "one past the cap must be refused (the cap is a cap): {}",
        refused.text()
    );
    assert_eq!(refused.json()["errors"][0]["rule"], "file-count-cap");
    assert_eq!(
        refused.json()["errors"][0]["message"],
        "This project already holds 500 design files; the cap is 500."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_already_larger_than_four_mib_accepts_new_files() {
    // The old budget: 4 MiB. This project is deliberately over it — which is
    // the ordinary state of a 500-page project (500 × ~8 KB), and the reason
    // the byte cap had to rise with the file count. 34 × 128 KiB ≈ 4.25 MiB.
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    seed_files(project, 34, 128 * 1024).await;

    let accepted = put_page(&app, user.id, project, "pages/fresh.html", "<p>fresh</p>").await;
    assert_eq!(
        accepted.status(),
        201,
        "a project over the OLD 4 MiB budget must accept new files: {}",
        accepted.text()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_byte_cap_refuses_a_write_that_would_cross_sixteen_mib() {
    // Fill to one full-size file short of 16 MiB, then write exactly that
    // file: it lands ON the cap, and the next byte over is refused. Both
    // edges, so the number cannot drift in either direction unnoticed.
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;
    let full_files = (16 * 1024 * 1024) / (128 * 1024); // 128 files
    seed_files(project, full_files - 1, 128 * 1024).await;

    // A valid page fragment of exactly 128 KiB: paragraphs pass the page rules
    // (no banned layout tags, no inline style), and the size rule is `>`, so
    // exactly-at-cap is legal.
    let full_page = "<p>x</p>".repeat((128 * 1024) / "<p>x</p>".len());
    assert_eq!(full_page.len(), 128 * 1024);

    let fills_the_project = put_page(&app, user.id, project, "pages/to-the-brim.html", &full_page).await;
    assert_eq!(
        fills_the_project.status(),
        201,
        "a write landing exactly ON the 16 MiB cap must be accepted: {}",
        fills_the_project.text()
    );

    let refused = put_page(&app, user.id, project, "pages/one-byte-over.html", "<p>over</p>").await;
    assert_eq!(
        refused.status(),
        422,
        "one byte past the cap must be refused: {}",
        refused.text()
    );
    assert_eq!(refused.json()["errors"][0]["rule"], "project-size-cap");
    assert_eq!(
        refused.json()["errors"][0]["message"],
        "Writing this file would exceed the 16 MB per-project cap."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_restore_cap_check_uses_the_same_raised_budgets() {
    // `restore_file` re-checks both caps for the restoring write; a raise that
    // only reached `write_file` would leave trash unusable at the new scale.
    let app = TestApp::new().await;
    let (user, project) = app.create_member_with_project().await;

    let seeded = put_page(&app, user.id, project, "pages/kept.html", "<p>kept</p>").await;
    assert_eq!(seeded.status(), 201, "{}", seeded.text());
    let trashed = app
        .delete_as(user.id, &format!("/api/design/{project}/page?route=/kept"))
        .await;
    assert_eq!(trashed.status(), 200, "{}", trashed.text());

    // 499 live files, one in the trash: restoring refills the 500th slot the
    // project provably has room for (the trashed row occupies none).
    seed_files(project, 499, 8).await;

    let restored = app
        .post_json_as(
            user.id,
            &format!("/api/design/{project}/trash/restore"),
            &json!({ "path": "pages/kept.html" }),
        )
        .await;
    assert_eq!(
        restored.status(),
        200,
        "the restored file must fit the raised file-count cap: {}",
        restored.text()
    );
}
