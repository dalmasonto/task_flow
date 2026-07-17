# Realtime + Messaging Rework — Progress Ledger

Plan: docs/superpowers/plans/2026-07-17-realtime-messaging.md
Branch: realtime-messaging
Merge base: main
Pre-work restore point: 374df9d

## Tasks
- [x] 1  Model changes (client_nonce, ChannelMember.project)
- [x] 2  Send endpoint
- [x] 3  Realtime per-table groups
- [x] 4  Seed chat workspace
- [x] 5  Regenerate client
- [x] 6  FE api layer (groups, subs, send)
- [x] 7  Reconcile reducer + vitest
- [x] 8  App.tsx collapse
- [ ] 9  File picker
- [ ] 10 End-to-end verification

## Minor findings (for final review triage)
- Task 8 Minor 1: a full fetchTaskflowWorkspace refetch replaces agentMessages wholesale, dropping
  any in-flight pending/failed optimistic bubble (and its Retry). Won't fire in normal incremental
  operation, but a refetch mid-send loses the bubble. Consider merging unreconciled pending bubbles
  across a refetch. VERIFY IN TASK 10.
- Task 8 Minor 2 (backend-contract SPOT-CHECK for Task 10): the whole no-dupe/no-stranded guarantee
  rests on the saved row carrying client_nonce back over BOTH the POST response AND the SSE echo,
  and on `project` being present in the SSE projection (the 1971 guard rejects echoes missing it).
  Tasks 3/6 should guarantee both -- Task 10's live run must actually observe them.
- Task 8 Minor 3/4: React key flips pending:<nonce> -> <id> on reconcile (harmless remount);
  send vs retry surface errors two different ways. Cosmetic.
- REPO HYGIENE: v2_fe tracks BOTH package-lock.json and yarn.lock. A live yarn/dev process keeps
  re-touching yarn.lock on package.json changes, so it drifts uncommitted. Post-Task-7 the two
  committed lockfiles disagree (package-lock has vitest, committed yarn.lock does not) -- a yarn
  install would miss the test toolchain. Pre-existing; the repo should pick ONE package manager.
  Not fixed under any task. FOR USER DECISION.
- SUFFIX DRIFT IS UNGUARDED (verified, not theoretical). Realtime group names are a cross-language
  contract between backend/src/realtime.rs (suffix consts + ALL_SUFFIXES) and
  v2_fe/src/lib/taskflow-api.ts (realtimeGroupSuffixes). A reviewer typo'd "task_sessions" ->
  "task_sessons" in the FE map and got ZERO TypeScript errors. The `satisfies` guard catches a
  MISSING suffix but not a WRONG one, and a wrong one fails SILENTLY -- the subscription opens and
  never fires. A Rust test reading the TS file and asserting each suffix passes the already-public
  can_join_group() would close it (~15 lines). Deliberately not built; decide at final review.
- Task 6: taskflowGroups.presence and realtimeEventHasInlineRow are exported but unconsumed until
  Task 8 branches on them. If Task 8 does not, the field projections buy nothing.
- Task 6: fetchTaskflowWorkspace still fetches agentChannelMembers unfiltered and filters
  client-side, though the model now has a project FK. Over-fetch only, not a correctness bug
  (this backend registers no paginator, so .list() cannot silently truncate). Cheap follow-up.
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
Task 4: complete (commits 1e443a7..d5e4b8c, review clean after 1 fix pass)
  Reviewer caught two Important defects the report missed: (1) no Environment::Dev guard, so the
  seed would inject a demo project into a Prod DB with real users and hand it to the lowest-id
  user; (2) non-transactional inserts + channel-only idempotency guard meant a crash between the
  project and channel inserts permanently crashed boot on the unique slug constraint. Both fixed
  (guard matches credentials.rs; umbral::transaction wraps all three creates, rollback verified
  against umbral-core). Prod guard verified empirically: UMBRAL_ENVIRONMENT=prod seeds 0 rows.
Task 5: complete (commits f2f29df..0a28660, review clean). client.d.ts only; client.js zero diff;
  no churn. One expected typecheck error left for Task 6: App.tsx:4816 createTaskflowAgentChannelMember
  missing required `project`.
Task 6: complete (commits 9935a5e..b5c9a3e, review clean, no fix pass needed)
  All 14 suffixes verified byte-for-byte against backend/src/realtime.rs by both implementer and
  reviewer independently. taskflow:agents retired FE-side. sendTaskflowAgentMessage posts to the
  trusted endpoint with only {channel, body_markdown, priority?, client_nonce?}.
  FOR TASK 8: TS excess-property checking stops at the FIRST bad key, so App.tsx:4897 reports only
  `project` -- but sender_kind, sender_user, and sender_label are ALSO passed and ALSO now
  server-derived. All four must be removed in one pass, or Task 8 chases them one error at a time.
Task 7: complete (commits 6ddc663..83fbb50, review clean after 1 fix pass)
  Pure nonce-keyed reconcile reducer + first vitest suite (now 12 tests). Reviewer ran 4 mutations;
  3 were caught, but reversing the key order (nonce-first -> id-first, the brief's "entire design")
  survived green because no test built the state where the two orderings diverge. Fixer added that
  test and PROVED it fails only when the order is reversed. Ordering now genuinely pinned.
  Deviation (verified sound): vitest ^3 -> ^4.1.10, because vitest 3 caps at vite 7 while this repo
  runs vite 8, which nested a duplicate vite and broke the config typecheck. vitest 4 dedupes.
Task 8: complete (commits f0b8cef..6d4297a, review clean, no fix pass -- 4 Minor notes deferred)
  Three message stores + two fixture blocks collapsed to one store. All four names grep-clean.
  Reviewer confirmed the projection payoff LANDS (realtimeEventHasInlineRow branch skips the GET for
  chat tables, no fall-through), send is order-independent (POST response AND SSE echo both reconcile
  by nonce), retry reuses the same nonce, sort fixed, send payload trimmed to 4 keys, createChannelMember
  passes project. Out-of-scope (attachments display, priority, terminal, file picker) all survived.
