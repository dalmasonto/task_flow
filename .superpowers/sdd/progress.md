# MCP Autoconnect + Profile Selection — Progress Ledger

Plan: docs/superpowers/plans/2026-07-24-mcp-autoconnect-profile-selection.md
Spec: docs/superpowers/specs/2026-07-24-mcp-autoconnect-profile-selection-design.md
Branch: feat/mcp-autoconnect-profiles
Merge base: main
Pre-work restore point: d8fb8f7

All work is in `mcp/`. Run commands from `/home/dalmas/E/projects/local_task_tracker/mcp`.

## Tasks
- [x] 1  Per-terminal sticky profile store (src/sessions-store.ts) — complete (commits 76c5a8d..32d1594, review clean; 12 tests)
- [x] 2  Ambiguous profile resolution (src/config.ts) — complete (commit bd91da5, review clean; 27 config tests)
- [x] 3  Profile-aware session identifiers (src/session-identifier.ts) — complete (commit a91331c, review clean; 269 tests)
- [x] 4  Connection lifecycle (src/connect.ts) — complete (commits 4433552..650240c, review clean; 18 connect tests, 287 total)
- [x] 5  Extract agent runtime from index.ts (src/runtime.ts) — complete (commit b686a7d, review clean; move verified opcode-by-opcode against the pre-move file)
- [x] 6  Startup wiring — connect first, mirror second (src/index.ts) — complete (commit 94edd30, review clean, mutation-verified; 302 tests). THE PLAN'S CORE FIX IS NOW LIVE: live-verified registering outside tmux.
- [x] 7  profile_ambiguous refusals + select_profile (src/server.ts) — complete (commits 762ce1a..c6ae56e, review clean, mutation-verified; 340 tests). Four Important defects found+fixed (liveness predicate, ensureSession profile gate, runtime teardown, ordering guard).
- [x] 8  Rewrite agent instructions (src/instructions.ts) — complete (commit c9b2ffe, review clean; 345 tests). Manual connect ritual + false "(default: main)" removed; one coherent Identity section.
- [x] 9  Build, install, verify against a real backend — automated + scriptable e2e all green (345 tests; pane-null connect, profile_ambiguous, select_profile+warning, whitespace guard, single-profile silent all proven live over real MCP+backend). Cold-restart / real --mint / dashboard-visual / cross-reconnect-stickiness deferred to user (need their backend restart, user token, browser). See task-9-report.md.

## Minor findings (for final review triage)
- Task 1 (Important, accepted as follow-up): outside tmux the sticky key is
  `cwd-hash:ppid`. OS pids get reused, and the retention window is 30 days, so a
  recycled ppid in the same repo can silently return a stale, unrelated profile
  pick instead of asking again — the exact mis-identification this feature exists
  to prevent. Mitigation would need something like the parent's start time in the
  key. Decide at final review whether to shorten retention for cwd-keyed entries.
- Task 1 (Minor): the "never throws when the store cannot be written" test uses
  `chmod 0o500`, which is a no-op under root. Passes vacuously in a root CI/Docker
  runner. Verified meaningful here (uid 1000).
- Task 1 (Minor): `.taskflow/.gitignore` containing `*` is what keeps the store out
  of git. It is pre-existing repo setup, not created by this task — a fresh clone
  elsewhere would need it.
- Task 4 (Minor, test sensitivity): finding 1's three guards in connect.ts
  (`reason()` inside `beat()`, the loop's try/catch, the `log` wrapper) are only
  pinned in PAIRS. Reverting any ONE alone still leaves 18/18 green. The production
  fix is present and correct; the tests just under-constrain it.
- Task 4 (Minor): no test pins the `run()` retry-catch `log` wrapper either —
  reverting it alone leaves the suite green, though a throwing `log` would end the
  retry loop silently.
- Task 4 (Minor): no test asserts the heartbeat still STARTS when `onSession`
  fails. Structurally it does (`void heartbeatLoop()` precedes the `onSession`
  await), but the covering test uses `autoHeartbeat: false` so nothing observes it.
- Task 4 (Note for Task 7): `startConnection` unconditionally publishes
  `{state:"starting", attempts:0}` at construction, so during `select_profile`
  `whoami` will briefly report `starting` with no session while the OLDER
  connection is still registered and heartbeating. Consistent with "newest owns
  the status", but Task 7 should expect it.
- Task 4 (Note): `register()` reads real `process.cwd()`, `process.pid` and
  `hostname()`. Inherited from the brief; the fakes discard the values, so unit
  tests touch the real process indirectly. Not a regression.
- Task 7 (Minor, accepted within brief): the ambiguity roster (`server.ts:203`,
  `roster ??=`) is memoised with NO TTL and cleared only by a successful
  `select_profile`. While the human has not yet picked, every refusal replays one
  frozen `in_use` snapshot even though the hint says `in_use` means "another
  terminal IS that agent right now". Finding 9 sanctioned "for the life of the
  ambiguity", so within brief — but a few-second TTL would keep the saving without
  the staleness. Consider at final review.
- Task 7 (Note): `ensureSession` will reuse a `stopped` connection's session id,
  because connect.ts publishes `{...status, state:"stopped"}` retaining `session`.
  Pre-existing, strictly narrower than before Task 7's profile gate, and
  `connectAs` overwrites the status immediately. Not actioned.

## Notes
- Task 7 Step 9 (`collisionPolicy`) is a decision reserved for dalmas — see
  pre-flight question. Do not let an implementer invent this policy.

---

## Previous plan (completed): GitHub Mirror Affordance

Merged. Kept only for its still-relevant environment findings:
- The repo's eslint baseline is DIRTY at 10 errors / 1 warning, all pre-existing
  in App.tsx / SettingsPage / message-attachments / markdown-renderer /
  client.d.ts. Compare lint against 10, never 0.
- Its manual verification matrix was never run (no browser tool available).
