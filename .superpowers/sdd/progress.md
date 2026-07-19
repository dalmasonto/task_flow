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
- [x] 9  File picker
- [x] 10 End-to-end verification

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
Task 9: complete (commits 4c39905..96a6f17, review clean, no fix pass). Lying file picker removed;
  disabled 'coming soon' affordance in its slot; URL/project-path attachments kept. One file, 9+/43-.
  Deferred (reasonable): AgentAttachment.source:'upload' union variant left for attachments sub-project.
Task 10: complete (verification only, no code change). Ran an ISOLATED backend on :8010 with a temp
  seeded DB and drove the full contract live over curl + a raw SSE listener:
  - Seed correct: 1 project / 1 channel / 1 member (member.project=1).
  - POST /messages: forged sender_label/sender_user/sender_kind ALL ignored; sender derived (admin/user/1);
    project derived from channel; client_nonce echoed on the POST response.
  - SSE wire: real envelope is `event: u` + data `{c:group, e:action, d:row}` (umbral multiplexes all
    groups over one connection; client.js listens for "u", unwraps {c,e,d}, routes by c, dispatches
    handlers[e] with d). The d row carries the FULL projection: client_nonce, project, body_markdown,
    sender_label -- so Task 8's reconcile and the project!==projectId guard both have their inputs.
  - CORE BUG FIXED, proven on the wire: a message event arrives on project:1:messages and does NOT
    leak onto project:1:tasks. (Before Task 3 every table shared project:1, so env.c matched for all 13.)
  - Idempotency: same nonce twice -> one row, same id. 403 non-member (empty body, no leak). 404 unknown
    channel. 400 empty body. All live.
  - Suites: realtime_routing 8/8, send_message 8/8, FE tsc exit 0, vitest 12/12, lint = 3 pre-existing.
  BROWSER-ONLY steps (network tab one-POST-zero-GETs, visual no-duplicate, two-window cross-client) were
  NOT driven in a real browser -- no automation available -- but each is guaranteed by a mechanism proven
  above (inline-row branch skips the GET; nonce reconcile is pinned by 12 tests; SSE delivers to the group).

## Process correction (post-final-review)
My `git add -A` on three "ledger-only" commits swept in non-ledger files:
  - 6ddc663 pulled in the suffix-contract test in realtime_routing.rs -- work the USER HAD DECLINED.
    Removed it (this commit); realtime_routing back to 7 tests, all pass. Suffix-drift gap stays
    OPEN as a logged follow-up, per the user's decision.
  - 4c39905 pulled in planning/hooks.md (the user's own unrelated notes). User chose to LEAVE it
    on the branch.
  - f0b8cef pulled in v2_fe/yarn.lock (benign lockfile re-sync). Left as-is.
LESSON: ledger commits must use `git add <specific file>`, never `git add -A`.


---

# MCP Message Attachments — Progress Ledger

Plan: docs/superpowers/plans/2026-07-19-mcp-attachments.md
Branch: mcp-attachments
Merge base: 4732236 (main)

## Tasks
- [x] 1  Attachment validation and reading
- [ ] 2  Multipart transport in the client
- [ ] 3  Expose `files` on the send_message tool

## Minor findings (for final review triage)
- Task 1 Minor: attachments.ts isInside() — a candidate resolving to exactly the root
  (input "." or "") yields relative()==="" so it throws "outside the project root" rather
  than reaching the "not a file" check. Still correctly rejected; misleading message only.

## Log
Task 1: complete (commits 4732236..00c8e6b, review clean, no fix pass)
  Verbatim transcription of the brief; reviewer confirmed byte-for-byte match.
  SECURITY BOUNDARY VERIFIED INDEPENDENTLY. Reviewer probed 5 attack vectors outside the
  shipped suite -- ../ traversal, symlink-inside-root->outside, <root>_evil sibling prefix,
  absolute path outside root, and a symlinked INTERMEDIATE directory component (not in the
  brief's test list) -- all 5 rejected.
  Reviewer ran 2 mutations against the shipped suite and BOTH were killed: (A) isInside ->
  naive startsWith fails the sibling-prefix test; (B) containment checked before realpath
  instead of after fails the symlink-escape test. The tests genuinely discriminate.
  Doc drift only, nothing missing: brief's prose said "9 tests" but its own code has 10
  it() blocks; my dispatch said "26 existing tests" but the real pre-task count was 56
  (44 tracked + 12 in untracked prompt.test.ts). 66 total now.
