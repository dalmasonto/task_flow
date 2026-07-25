# Dashboard Page (#60) — Progress Ledger

Plan: docs/superpowers/plans/2026-07-25-dashboard-page.md
Spec: docs/superpowers/specs/2026-07-25-dashboard-page-design.md
Branch: feat/dashboard-page-60
Merge base: main
Pre-work restore point: 1d43317
TaskFlow task: #60 (Dashboard half; Media page is a separate cycle)

Backend: backend/ (cargo test --workspace — bare `cargo test` skips plugins).
Frontend: v2_fe/ (vitest node env, no jsdom).

## Tasks
- [x] 1  closed_at column + reconciler stamping + backfill (taskflow-tasks) — complete (commits 7af6344..274ac87, review clean after fix; 6 reconciler tests, workspace green). Fixed an Important backfill bug (my plan's snippet): a no-op save for updated_at==None re-fired the reconciler and fabricated a boot-time closed_at.
- [x] 2  project stats endpoint (taskflow-tasks views/urls) — complete (commits a8ae1e0..5190602, review clean; 7 project_stats tests, workspace green). Note: test filter is `--test project_stats` (not a bare name). active_members correctly counts any in-range session (not gated on duration) — spec fix over the brief's worked.len().
- [x] 3  frontend stats fetch + pure shaping helpers (dashboard-stats.ts, taskflow-api.ts) — complete (commit 622c9d6, review clean; 8 dashboard-stats tests, 156 total; fillDaySeries verified UTC-safe across timezones). Minors (non-blocking): fillDaySeries param typed `string` not `StatsRange`; formatWorkedTime(NaN)→"NaNm" (backend never sends NaN).
- [x] 4  Dashboard overview page UI (OverviewPage.tsx, App.tsx route+nav) — complete (commits 32598b6..0207583, review clean after fix; build clean, 0 new lint, 156 tests). Fixed an Important stale-data-on-project-switch bug (data now tagged with dataProjectId → displayData gate), a 404 access-notice branch, and a generated_at NaN guard.
- [x] 5  live verification — backend+frontend suites green (workspace + 156 fe tests, builds clean); stats route confirmed LIVE on the running backend (401 auth-gated vs 404 garbage; closed_at migrated in live DB); fresh Vite serves the Dashboard nav + OverviewPage. Browser render of the charts is the user's manual pass (no browser here).

## Minor findings (for final review triage)
- Task 1 (Minor): the boot backfill's `tokio::spawn` future is tied to the
  triggering test's runtime in test binaries (can be dropped mid-flight in tests);
  no production impact. Matters only if a later task adds a backfill-specific test.
- Task 1 (Minor): backfill does an unfiltered `fetch()` of all tasks then filters
  in Rust; a `.filter(status in [...] & closed_at.is_null())` would shrink the
  one-time boot query. Not correctness.
- KNOWN PRE-EXISTING failure (not ours): `taskflow-agents::send_message::
  rejects_body_over_max_chars_with_400` fails on base too (message-length, unrelated).
  Workspace is otherwise green.

## Notes
- Terminal statuses = Done, Archived (PartialDone is NOT terminal).
- Reconciler is re-entrant; is_none()/is_some() guards make closed_at writes terminate.
- No raw SQL / no ORM aggregation in this codebase — stats endpoint fetches by
  project and reduces in memory (the activity_actions pattern).
- Charts are dependency-free (SVG/CSS); do NOT add a chart library.
- Restart the Vite dev server for the new page/route (stale long-running server).

---

## Previous plans this session (completed + merged)
- MCP autoconnect + profile selection → main (cc1b8c4).
- GitHub social login → main (31db1cf). Dev server was stale; restarted.
