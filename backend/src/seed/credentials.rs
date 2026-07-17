//! First-run convenience: mints a dev superuser `admin` when no users
//! exist yet — but ONLY in the Dev environment AND only when you opt in
//! by exporting a password. There is deliberately NO hardcoded default
//! password: a bare `./app` launch against an empty production database
//! must never plant a known-credential admin account.
//!
//! To auto-seed the dev superuser:
//!
//!   UMBRAL_DEV_ADMIN_PASSWORD=your-dev-password cargo run
//!
//! Otherwise the first boot prints guidance to run
//! `cargo run -- createsuperuser` and seeds nothing. Idempotent —
//! subsequent boots find the user and stay quiet.

use umbral::Environment;
use umbral_auth::AuthUser;

/// Env var that opts a fresh install into the dev-superuser seed and
/// supplies its password. Unset => no seed (print guidance instead).
const DEV_ADMIN_PASSWORD_ENV: &str = "UMBRAL_DEV_ADMIN_PASSWORD";

pub async fn test_credentials() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Never mint a dev superuser outside the Dev environment — belt and
    // suspenders on top of the caller only running us on a bare launch.
    if umbral::settings::get().environment != Environment::Dev {
        return Ok(());
    }

    // Idempotent: bail out the moment any user exists.
    if AuthUser::objects().count().await? > 0 {
        return Ok(());
    }

    // Opt-in only: without an explicit password we plant nothing. This
    // is what keeps a known `admin`/`admin` account off every fresh DB.
    let password = match std::env::var(DEV_ADMIN_PASSWORD_ENV) {
        Ok(p) if !p.is_empty() => p,
        _ => {
            eprintln!();
            eprintln!("No users yet, and no dev superuser was seeded. To create one:");
            eprintln!("  • interactive:  cargo run -- createsuperuser");
            eprintln!("  • auto on boot: set {DEV_ADMIN_PASSWORD_ENV}=... and restart");
            eprintln!("                  (Dev environment only; never seeds in Prod)");
            eprintln!();
            return Ok(());
        }
    };

    umbral_auth::create_superuser("admin", "admin@example.com", &password)
        .await
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })?;

    eprintln!();
    eprintln!("======================================================================");
    eprintln!(" DEV SUPERUSER seeded (Dev environment, {DEV_ADMIN_PASSWORD_ENV} set)");
    eprintln!("----------------------------------------------------------------------");
    eprintln!(" Username : admin");
    eprintln!(" Password : (the value of {DEV_ADMIN_PASSWORD_ENV})");
    eprintln!(" Log in   : http://127.0.0.1:8000/admin/");
    eprintln!(" Remove or edit src/seed/credentials.rs before shipping.");
    eprintln!("======================================================================");
    eprintln!();

    Ok(())
}
