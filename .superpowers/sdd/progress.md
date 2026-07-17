# Realtime + Messaging Rework — Progress Ledger

Plan: docs/superpowers/plans/2026-07-17-realtime-messaging.md
Branch: realtime-messaging
Merge base: main
Pre-work restore point: 374df9d

## Tasks
- [x] 1  Model changes (client_nonce, ChannelMember.project)
- [x] 2  Send endpoint
- [x] 3  Realtime per-table groups
- [ ] 4  Seed chat workspace
- [ ] 5  Regenerate client
- [ ] 6  FE api layer (groups, subs, send)
- [ ] 7  Reconcile reducer + vitest
- [ ] 8  App.tsx collapse
- [ ] 9  File picker
- [ ] 10 End-to-end verification

## Minor findings (for final review triage)
- Task 3: can_join_group does not validate the {id} component is numeric, so `project:abc:messages`
  is joinable (an empty group). Moot once row-level membership lands.
- Task 3: ALL_SUFFIXES has no compile-time link to the .expose::<T>() calls. A newly added model
  could emit a suffix missing from the set -- emitted but unjoinable -- with no test catching it.
- MERGE GATE: Tasks 3 and 6 must land together. Task 3 retires the old group names, so the SPA's
  realtime is dark between them.
- Task 2: idempotency is read-then-insert, so two SIMULTANEOUS same-nonce posts can both insert.
  Closing it needs unique_together(channel, client_nonce) + a migration. The realistic case
  (sequential retry after a dropped response) is covered. Decide before any multi-writer use.
- Task 2: malformed JSON yields 422 (axum's Json extractor), not 400. Task 6's client error
  handling should not assume 400 for schema violations.

## Log
Task 1: complete (commits d644e80..2c00d0c, review clean — both verdicts PASS)
  Deviation (reviewer-validated): plan's "recreate dev DB" was wrong. makemigrations rejects a
  NOT NULL FK ALTER via a static UnsafeAlter check regardless of row count. Fix: regenerated the
  plugin's only migration (0001_auto.json) so both columns land in the initial CREATE TABLE.
  Sound only pre-production; spec updated to say so.
Task 2: complete (commits 3afddc5..9f23db4, review clean after 1 fix pass)
  SECURITY: the plan had idempotency checked BEFORE membership. A reviewer proved empirically
  that a non-member replaying a guessed nonce got 200 + the full message body while all 6
  original tests stayed green. Order is now body->404->403->idempotency->insert, pinned by a
  regression test that was verified to fail when the order is reversed.
  Framework reality vs plan guess: Identity is not an extractor (used RequireAuth<i64>);
  user_id is String not i64; inserts are objects().create() not .save(); ForeignKey::new(id).
  backend/Cargo.toml gained [workspace] members=["plugins/*"] so plugins with dev-deps are testable.
Task 3: complete (commits 1f8a47b..8f1bfe0, review clean, no fix pass needed)
  ROOT CAUSE FIXED. All 14 project-scoped models now route to project:{id}:{suffix}; chat tables
  carry field projections (client_nonce included); taskflow:agents retired; presence isolated.
  Implementer found the brief's 4 policy tests did not discriminate (a prefix-only policy passed
  all of them) and added 3, incl. rejects_groups_whose_suffix_is_not_a_known_label. Reviewer
  independently sabotaged both ways: group_for ignoring suffix fails 3 tests, prefix-only policy
  fails 1. Tests genuinely discriminate.
  Reviewer confirmed the chat projections make NOTHING newly reachable -- auto-REST is already
  unscoped (IsAuthenticated only), so any user can already GET any project's messages. The
  projection converts pull to push. Real fix is the permissions sub-project.
