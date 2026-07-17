//! Admin dashboard widgets — the re-export / discoverability layer,
//! grouped by kind so each file stays small and focused on one
//! rendering shape.
//!
//! Submodules:
//!   - `cards` — KPI tiles + dashboard sections.
//!
//! Add `pub mod charts;`, `pub mod tables;`, etc. as your dashboard
//! grows, then re-export the builders so `main.rs` calls them as
//! `widgets::cards::overview_section()` without knowing which file owns
//! each one. A recommended convention — restructure freely.

pub mod cards;
