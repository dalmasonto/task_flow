//! Seed orchestrator — the re-export / dependency-order layer. One
//! file per concern keeps each step small and focused; `all()` pins
//! the order in which they run.
//!
//! Submodules:
//!   - `credentials` — first-run dev superuser so you can log in to
//!                     /admin/ without a manual `createsuperuser`.
//!   - `chat`        — a real project, channel, and membership so a
//!                     fresh dev DB has something to render. Runs after
//!                     `credentials` because it needs the dev user.
//!
//! Add a `pub mod <concern>;` here for each new seed step, then call it
//! from `all()` in dependency order (e.g. catalog rows before the orders
//! that reference them). The order in `all()` doubles as documentation
//! of which step depends on which.

pub mod chat;
pub mod credentials;

/// Run every seed step in the right order. Each step is idempotent
/// (short-circuits on a non-empty table), so calling `all()` on a
/// partially-seeded DB tops up the missing pieces without re-inserting.
pub async fn all() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    credentials::test_credentials().await?;
    chat::dev_workspace().await?;
    Ok(())
}
