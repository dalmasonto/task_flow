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
Task 2: complete (commits 00c8e6b..7abb06b, review clean, no fix pass -- 2 Minor deferred)
  FetchLike widened to string|FormData; request() gained mutually-exclusive form/body branches
  plus a per-request timeoutMs override; sendMessage posts multipart at 120s when attachments
  are present, JSON otherwise.
  REGRESSION RISK CLEARED. Reviewer enumerated ALL 18 pre-existing request() callers and
  confirmed every one passes only query/body, so all fall to the unchanged else-if branch with
  the 15s default. AbortSignal wiring untouched. server.ts:295 (the only sendMessage caller
  today) passes no attachments, so it still hits the byte-identical JSON path.
  Reviewer ran 3 mutations, ALL killed: (A) manually setting Content-Type: multipart/form-data
  fails the no-Content-Type test; (B) appending under distinct field names files0/files1 fails
  getAll("files"); (C) dropping the filename arg makes FormData default the part name to "blob",
  failing the basename assertion.
  My process error, not the implementer's: I left .superpowers/sdd/progress.md staged, so their
  bare `git commit` swept it into 7abb06b. Harmless (that dir is gitignored except the ledger).
  Do not pre-stage the ledger again.
Task 3: complete (commits 7abb06b..2bcbcb7, review clean, no fix pass -- 1 Minor deferred)
  files param exposed on send_message; root is dirname(configPath) from the enclosing scope.
  BOUNDARY BOUND TO THE REAL ROOT AND VERIFIED EMPIRICALLY. Reviewer ran the actual
  findConfigPath -> dirname -> resolveAttachments composition from compiled dist/ against the
  real .taskflow.json: configPath resolves to the file (never a bare dir, so dirname is right),
  root = /home/dalmas/E/projects/local_task_tracker, /etc/passwd rejected "outside the project
  root", ../../.ssh/id_rsa rejected. This is the binding Task 1's synthetic-temp-root tests
  could not cover.
  Error path traced: AttachmentError extends Error, the await sits inside the tool's try, so it
  lands in fail()'s instanceof Error branch as isError:true -- never escapes the tool.
  Absent/empty files both yield attachments:undefined (not []), so sendMessage takes the JSON
  path unchanged.
  Minor (report only, no code change): task-3-report.md:54 claims ResolvedProfile has no
  configPath field. It does (config.ts:60-69). The code is right per the brief; the stated
  justification is wrong.
  STILL UNVERIFIED, NEEDS A LIVE RECONNECT: zod validation + JSON-RPC serialization of `files`
  over a real MCP round-trip. 4-item manual checklist in task-3-report.md.

## Test count churn (explains conflicting numbers across tasks)
Counts moved 66 -> 71 -> 59 -> 69 across the three tasks because the USER was concurrently
editing test files in the same directory: prompt.test.ts appeared then was removed (12), and
events.test.ts grew 9 -> 19 uncommitted. Tasks 1-3 own exactly 15 of the current 69
(attachments 10 + client 5); none were lost. No task's numbers were wrong at the time it ran.

## FINAL WHOLE-BRANCH REVIEW: DO NOT MERGE (2 Critical)
Root cause is MINE, at the spec stage. The design doc's central premise "No backend change is
required" is FALSE, and it propagated through the plan into all three tasks. Each task correctly
implements a wrong premise.

I read the multipart parsing at views.rs:143-207 and assumed it served the agent path. It does
not. That is `send_message`, the HUMAN RequireAuth route at /api/taskflow/agents/messages. The
MCP authenticates with `Authorization: Agent <key>` and posts to a DIFFERENT route,
/api/taskflow/agents/agent/messages -> send_message_as_agent (urls.rs:60-65), which is JSON only.

VERIFIED INDEPENDENTLY (not taken on the reviewer's word):
  - views.rs:756  send_message_as_agent takes Json(input) -- no multipart branch at all
  - views.rs:745  its doc says "JSON only -- agent sends carry no attachments in Stage 1"
  - views.rs:838  hardcodes message_response(&message, &[])
  - urls.rs:62-65 the agent route carries NO DefaultBodyLimit layer; the 32MB layer
                  (SEND_MESSAGE_BODY_LIMIT, urls.rs:20) sits only on the human route

C1: a files send posts multipart to axum's Json extractor -> 415 before the handler runs.
C2: even once parsing is added, that route inherits axum's 2 MiB default, so the client's 25MB
    cap is off by 12x against the route it actually calls. Same axum footgun already in memory.

I1 (Important): NO test at any layer crosses the client/server boundary. client.test.ts asserts
shape against a stubFetch that returns {ok:true} for ANY url, so it cannot see a wrong endpoint.
The verification gap and the defect are the same gap: Task 3's live e2e was the one step that
would have crossed it, and it is the step we could not run.

Deferred Minors: all 4 triaged NON-blocking. #3 narrowed -- the empty-string priority asymmetry
is unreachable, the zod enum forbids it.

DECISION: add Task 4 (backend multipart on the agent route). MCP commits 00c8e6b..2bcbcb7 stand.

## Task 4 (added after the final review found the spec's premise was wrong)
- [x] 4  Accept multipart on the agent send route
Task 4: complete (commits b4fa017..95ffebe + fix f57b99f, review clean after 1 fix pass)
  send_message_as_agent now takes HeaderMap+Bytes and branches on content-type, mirroring the
  human send_message line-for-line. Agent route gained DefaultBodyLimit::max(SEND_MESSAGE_BODY_LIMIT).
  NO UNINTENDED DRIFT. Reviewer diffed the two handlers: normalisation, field match arms, channel
  parse, priority-drop rule, file-part filename filter, empty-body-with-files rule, 413 block,
  channel lookup, idempotency block and storage loop are line-for-line identical. Only the four
  that MUST differ do: RequireAgent vs RequireAuth, input struct, agent membership gate, sender trio.
  DefaultBodyLimit placement PROVEN load-bearing: a 3 MiB multipart upload returns 200 as written;
  delete the .layer() line and the same request dies "length limit exceeded".
  IMPORTANT FINDING, FIXED. The membership-before-idempotency ordering (a non-member must not
  replay a guessed nonce and read back a stored message) had NO test on the agent route. Reviewer
  proved it: relocating the idempotency block above the membership gate left 30/30 green. Case 5
  could not catch it -- it sends no client_nonce, so the reordered lookup is a no-op.
  Fix f57b99f adds agent_non_member_replaying_a_nonce_gets_403_not_the_stored_row, mirroring the
  human anchor at tests/send_message.rs:255. Discrimination proven TWICE, independently, by fixer
  and re-reviewer: under the mutation the outsider gets 200 and the member's "secret plans" body
  leaks back. The Direct-channel choice is load-bearing -- in a shared project room the "outsider"
  would be legitimately authorized by project scope and the test would prove nothing.
  Implementer staged a 4th file (tests/support/mod.rs) beyond the brief: post_multipart_as_agent
  and count_project_attachments. Reviewer judged it necessary -- TestApp.client is private, there
  was no multipart+agent helper, and count_attachments is message-keyed which case 5 cannot use
  (its whole assertion is that no message exists). Purely additive.
  Behaviour change, accepted: a bogus content-type used to 415 from the Json extractor, now falls
  to the JSON branch and 400s. Reviewer verified the human route has always behaved this way.
  Nuance the report missed: well-formed JSON sent as text/plain now SUCCEEDS (200) where it used
  to 415. A real loosening, but auth is header-based and the input struct has no field to lie in.

## Minor findings (final-review triage)
- Body limit is load-bearing but untested on BOTH routes: delete the .layer() line and no test
  fails. Pre-existing on the human route, not introduced here. One >2 MiB case would pin it.
- The 413 oversize branch (views.rs:844-849) is unexercised on both routes.
- I1 from the final review STANDS: no test at any layer crosses the client/server boundary.
  client.test.ts asserts shape against a stub returning {ok:true} for ANY url. This is why the
  wrong-endpoint defect survived three clean task reviews.
