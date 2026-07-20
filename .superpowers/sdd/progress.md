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

---

# Agent Attachment Visibility — Progress Ledger

Plan: docs/superpowers/plans/2026-07-19-agent-attachment-visibility.md
Branch: agent-attachment-visibility
Merge base: 5d801eb (main)

## Tasks
- [x] 1  Return attachments from the agent read path
- [ ] 2  Validate, sanitize, and write a downloaded attachment
- [ ] 3  Expose the download_attachment tool

## Minor findings (for final review triage)
- views.rs:2588-2592 grouping is O(messages x attachments) with a clone per match. Negligible at
  effective_limit (default 50, max 200); a HashMap pass would avoid it. Readability wins for now.
- views.rs:101 `if let Value::Object(map)` silently no-ops on a non-object, which would drop the
  attachments key -- the exact failure this task exists to kill. Unreachable today (the message is
  a struct). Pre-existing shape carried over from the original message_response.

## Log
Task 1: complete (commits 1ab8a74..2c3a6b6 + fix 7ee0d6a, review clean after 1 fix pass)
  attachment_json is now the SOLE place attachment field names appear; message_json inserts the
  key unconditionally; message_response's signature unchanged so no caller moved.
  DEDUPLICATION IS REAL, NOT COSMETIC. Reviewer grepped every attachment field name across
  views.rs: exactly one site each (lines 77-85). The old inline json! block is deleted, not copied.
  Send path reaches it via message_response -> message_json; read path via message_json directly.
  Two of three new tests proven load-bearing by mutation: dropping created_at from the read path
  only fails case 10 (parity) and nothing else; making message_json skip the key when empty fails
  case 9 (the exact original defect).
  IMPORTANT FINDING, FIXED. The grouping predicate had NO test. Reviewer replaced
  `.filter(|a| a.message.id() == message.id)` with `.filter(|_a| true)` -- assigning every
  attachment on the page to every message -- and all 14 tests stayed GREEN. All three new tests
  used a page with effectively one relevant message, so the filter was never discriminating.
  Real risk: a refactor comparing the wrong ids leaks every message's files onto every other
  message in the channel, suite still green.
  Fix 7ee0d6a adds a MIXED-PAGE test (A text-only, B one file, C two files) asserting per-message
  counts and that every attachment's `message` field equals its host id. Proven: neutralising the
  filter fails it, showing A polluted with B's and C's files. 15/15 now.
Task 2: complete (commits 7ee0d6a..288ed19 + fix 574667d, review clean after 1 fix pass)
  attachment-download.ts: mediaPathFrom / downloadFilenameFrom / downloadDirFor / downloadAttachment.
  21 tests in the file, 101 across the suite.

  MY PLAN CONTAINED A SELF-CONTRADICTION. Its Step 1 test asserted
  https://evil.example/media/x must throw, but its paired Step 3 implementation only extracted
  pathname and never inspected the host -- so that url (whose PATH is /media/x) was accepted and
  the test failed against the plan's own code. The implementer caught it and traced it properly.
  IMPORTANT NUANCE, established by the reviewer and initially mischaracterised by both the
  implementer and me: the plan's implementation was SECURE, not an SSRF hole. It discarded the
  host and downloadAttachment always fetched ${opts.server}${mediaPath}, so evil.example was
  never contacted. Only the TEST was wrong. The contradiction could have been resolved in either
  direction; the implementer tightened the implementation without noticing the tested property
  was never load-bearing.

  CRITICAL FINDING, FIXED. Nothing pinned the fetch target. Reviewer replaced the url-building
  line with `const absolute = opts.url;` -- a textbook SSRF, fetching the raw untrusted url --
  and ALL 16 TESTS STAYED GREEN, because stubFetch was `async () => ({...})` and discarded its
  arguments. The single property making this module safe rather than an arbitrary-url fetcher
  with a disk write attached had zero coverage. Fix adds a RecordingFetch asserting the full
  absolute target string; mutation now fails it, confirmed independently by fixer and re-reviewer.

  IMPORTANT FINDING, FIXED. The loopback allowlist (localhost/127.0.0.1/::1) rejected users' OWN
  servers at 192.168.1.50, taskflow.lan, or any remote deployment -- unfixable without editing
  source, and inconsistent with client.ts/events.ts/tmux.ts which accept any origin. Replaced
  with a configured-origin comparison (scheme+host+port). Verified: wrong scheme rejected, wrong
  port rejected, non-localhost matching origin accepted. The "::1" entry was dead code anyway --
  WHATWG URL returns IPv6 hosts bracketed as "[::1]".

  MINOR, fixed: percent-encoded traversal was asymmetric -- resolve() does not decode, so
  /media/%2e%2e/... passed the bare-path branch while the absolute branch decoded and rejected it.
  Both branches now decodeURIComponent before normalising, guarded against malformed sequences.
  Double-encoding (%252e%252e) still decodes only one level and is accepted; not exploitable,
  since the write target is a contained basename and path.relative is the real backstop.
Task 3: complete (commits 69f929f..994e089, review clean, no fix pass, NO findings)
  download_attachment tool registered; root is dirname(configPath); resolved.key threaded so the
  auth-header slot is live; description carries both required warnings (files-in-general, and
  check size_bytes before reading anything wholesale).
  END-TO-END VALUE SHAPE TRACED ACROSS ALL THREE TASKS -- the check the previous feature lacked.
  Task 1's attachment_json emits "url": a.file.url(); the storage mount is .media("/media",
  "./media") (main.rs:152), so FileField.url() yields a RELATIVE /media/<key> string, matching
  MEDIA_PREFIX in attachment-download.ts:42. Task 3 forwards it unmodified; mediaPathFrom takes
  the bare-path branch (fails the protocol-scheme regex), decodes, normalises, accepts. No
  mismatch. This is the exact defect class that shipped last time (client posting to a JSON-only
  endpoint while every unit test passed) and it does not exist here.
  Error path verified: AttachmentDownloadError extends Error, the await sits inside the tool's
  try, so it lands in fail()'s instanceof Error branch as isError:true and never escapes.
  STILL UNVERIFIED, NEEDS A LIVE RECONNECT + BACKEND RESTART: 6-item manual checklist in
  task-3-report.md, all marked NOT RUN. Checks 5 and 6 (cross-origin url rejected, non-/media
  path rejected) matter most -- they are the security boundary against the real configured server.

## FINAL WHOLE-BRANCH REVIEW: 1 Important defect found, fixed in 4d9509a
THE DEFECT ONLY A WHOLE-BRANCH REVIEW COULD SEE. The backend emits attachment urls UNENCODED --
FsStorage::url() is format!("{mount}/{key}") and the storage sanitiser strips only / \ and control
chars, so #, ?, %, &, spaces and unicode all survive verbatim. downloadAttachment then DECODED
that path and concatenated it onto the origin WITHOUT re-encoding. Proven with a recording stub:
  "uuid-Q3 #2 report.pdf" -> requests /media/uuid-Q3%20  (truncated at #)  -> 404
  "uuid-a?b.png"          -> requests /media/uuid-a      (truncated at ?)  -> 404
  "uuid-50%.png"          -> no fetch at all; thrown as "not a valid url"
A user attaches "Q3 #2 report.pdf", the agent sees a correct-looking url and gets 404 for a file
that exists. The spec listed # and & under "must survive" -- but only tested them against
downloadFilenameFrom (the ON-DISK name), never against the fetch target. Each layer was right
about itself.
Fixed: per-segment encodeURIComponent when building the target; decode failure is now non-fatal
(a lone % is a legal filename char). Mutation-proven -- reverting the encoding fails exactly the
4 new tests and nothing else.

CONTRACT-PAIR TEST ADDED (the structural fix for the repeat blind spot). The Rust side now
asserts the FULL emitted url for a filename with a space and a #, and positively asserts the
ABSENCE of encoding (no % anywhere). The TS side feeds that exact literal through and asserts the
encoded request path. Comments in both name the other as its pair. If a storage backend later
starts encoding, Rust fails loudly next to the explanation instead of the client breaking
invisibly.
Minors also fixed: .gitignore now written only if absent (it was OVERWRITING, not just churning);
decode loops until stable (caps at 5) so double-encoding no longer relies on the upstream decoder.

## Deferred Minors (triaged NON-blocking by the final reviewer)
- views.rs grouping O(messages x attachments) with a clone; bounded by limit <= 200.
- views.rs:101 `if let Value::Object` no-ops on a non-object; unreachable (to_value of a struct).
- attachment-download.ts sends the agent key on every /media request TODAY, while the spec
  describes the header as added later. Harmless, but it puts the credential in the static
  server's access logs from day one. Code and spec narrative have diverged.

## SECURITY TRADE, JUDGED WHOLE: holds, with one recorded assumption
Reviewer traced every path that could hand an agent a /media key: list_messages_as_agent gates on
agent_can_see_channel before reading anything; list_channels_as_agent filters to the agent's
project and requires an explicit roster row for DMs; the batched attachment query is filtered by
message id but the message set is already channel-gated; and attachment_json is the ONLY site in
the plugin calling .url()/.key() (grep-verified). Urls leak nowhere else.
THE LOAD-BEARING ASSUMPTION: agent_can_see_channel (views.rs:2367-2370) returns true on a roster
row WITHOUT re-checking project -- the project check is only on the fallback branch. A
cross-project roster row would therefore grant cross-project attachment urls, and with an
unauthenticated download that is file exfiltration rather than just text. Unreachable today (the
human add-member endpoint adds users only; the sole agent-roster creation site is
ensure_project_room, which always uses the agent's own project). PRE-EXISTING, not introduced
here -- but this branch raises its consequence. Record it against the framework-level media fix.

---

# Trusted Channel Creation — Progress Ledger

Plan: docs/superpowers/plans/2026-07-20-trusted-channel-creation.md
Branch: channel-member-write-gate
Merge base: 09b3c1b (main)

## Tasks
- [x] 1  Trusted create-channel endpoint
- [ ] 2  Point the frontend at it
- [ ] 3  Strip Create from auto-REST

## Minor findings (for final review triage)
- views.rs:480-536 duplicate member entries return 500, not 400. members:[{user:X},{user:X}]
  violates the (channel,user) unique index. Rollback VERIFIED by the reviewer (before==after==0),
  so integrity holds -- but after Task 3 this is the ONLY creation path, so a client bug becomes
  a 500 rather than a validation error. Reviewer: "should not ship to Task 3 unfixed."
- views.rs:541 input.task is not validated against input.project. Reachable by any active member.
  NO read-access leak -- visible_channel_ids keys off channel.project and the roster, never
  channel.task -- but channel.task is copied into every message, so project A messages can carry
  a project B task id. This codebase ALREADY has the fix as a named helper: scoped_task_link()
  (views.rs:2443-2459) drops a foreign-project task to None, with a test asserting it
  (tests/activity_ingest.rs:178). The handler is inconsistent with an established local
  convention and the fix is one call.

## Observations (pre-existing, not this branch)
- realtime.rs:206 routes TaskflowAgentChannel events via a PROJECT group with CHANNEL_FIELDS
  including title and kind -- so DM existence and title broadcast to the whole project even
  though visible_channel_ids correctly hides them over REST. Same threat model as this series;
  deserves its own ticket.
- No DM dedup anywhere: two calls naming the same person create two DMs. ensure_project_room
  does find-or-create for project rooms; DMs have no equivalent.

## Log
Task 1: complete (commits 09b3c1b..8adce1b + fix ad7b4d5, review clean; both Minors CLOSED)
  create_channel + route + 6 tests. 79 tests pass across the plugin.
  SECURITY CORE VERIFIED BY THE REVIEWER, not taken on trust. They could construct no path to an
  unauthorized roster row: non-active user rejected pre-transaction; foreign agent rejected at
  views.rs:523; display_name/role have NO serde path at all (CreateChannelMemberInput carries
  only kind/user/agent), which is a real tightening -- the current frontend passes client-chosen
  name and role today; foreign project 403s; created_by_user comes from RequireAuth.
  Two mutations, both killed: deleting the agent-project check fails
  an_agent_from_another_project_is_rejected; removing the caller auto-insert fails THREE tests.
  ATOMICITY NUANCE the reviewer corrected in the implementer's report: test 5 passes because
  validation happens BEFORE the transaction opens, not because of rollback. That is the stronger
  property (zero writes vs write-then-undo), but it means real rollback has no committed test.
  The reviewer verified rollback empirically with a throwaway test (before==after==0).
  Forced deviation, verified necessary: the brief's bare Ok((channel, rows)) does not compile --
  umbral::transaction is generic over E: From<sqlx::Error>, leaving E unconstrained (E0283).
  Pinned as create_project does. Behaviour identical.
  Both Minors fixed in ad7b4d5 rather than deferred, since after Task 3 this is the only
  creation path: duplicate targets are now deduped before the transaction (silently, matching
  the existing caller-dedup), and the task link uses scoped_task_link() so a foreign-project
  task drops to None per the established convention. 81 tests pass. Dedup mutation-proven --
  removing the guards makes the duplicate test 500 again.
Task 2: complete (commits ad7b4d5..518fd76, review clean, no fix pass -- 1 Minor deferred)
  ensureLiveChannel collapsed to one createTaskflowChannel call; workspace merges the response's
  real roster rows rather than optimistic ones.
  ROSTER SEMANTICS PRESERVED, verified branch by branch by the reviewer against the pre-diff code:
  human DM -> same target; agent DM -> identical incl. the `?? chat.liveAgentId` fallback; shared
  room -> old code added currentUser then looped all active members (deduped by the `added` Set),
  new code filters currentUser out and lets the server add them. Net roster identical, and the
  caller is never sent in members in any branch.
  The old silent-drop bug is now STRUCTURALLY impossible: addUser returned early when
  currentUser?.id was falsy, dropping a member with no error. The caller now comes from
  RequireAuth, which cannot be falsy past that gate.
  created_by_user and archived are no longer sent -- correctly, the server derives both.
  Minor (deferred): createTaskflowChannel uses readErrorDetail (reads detail/error), but the
  backend's non-member 400 is {code, user:[...]}, so it falls through to a generic message. The
  sibling readFieldErrorMessage handles that shape. Reviewer traced reachability: ensureLiveChannel
  is only called from sendLiveMessage, whose targets come from the project's own loaded roster, so
  the path is near-unreachable today. Becomes real if channel creation ever gets a UI with a
  typed-in target.
  Lint stayed at the baseline of 4; the App.tsx:2161 -> :2175 drift is the user's concurrent edits,
  confirmed by reading the line (an unrelated auth-gate effect).
Task 3: complete (commits 518fd76..2c92144 + fix 5b77b55, review clean after 1 fix pass)
  Create stripped from taskflow_agent_channel ([List,Retrieve,Update,Delete]) and
  taskflow_agent_channel_member ([List,Retrieve]). channel_scope and visible_channel_ids untouched.
  THE HOLE WAS REPRODUCED BEFORE IT WAS FIXED, by the implementer AND independently by the
  reviewer: reverting the .views() calls makes both escalation tests return 201 Created (roster
  row id:6 on channel:4; channel id:5 titled "Sneaky"). That is the live vulnerability, observed.
  405 is the honest value, not a guess: umbral-rest lib.rs:511 mounts POST only if Create is
  exposed, and gate() returns 405 while any method remains mounted (List keeps GET alive). Same
  value the repo already pins in create_project::auto_rest_create_is_405.
  No substitute route: POST /channels/{id}/members has a DM carve-out (views.rs:698-708) requiring
  the caller to already be on that roster; project membership is not enough.
  My PLAN DEFECT, caught by the implementer: the brief's test snippet called seed() directly, but
  seed() is the one-shot routine inside the APP OnceCell -- calling it from a test would re-seed
  the shared DB and could race ahead of create_tables_for_tests(). It also used a field name that
  does not exist (seed.project vs project_p) and a json! macro with no import. They used
  app().await like every other test in the file.

## SCOPE EXPANSION (deliberate): the same hole one table over
  The reviewer probed taskflow_agent_message and found auto-REST Create still exposed: an ordinary
  project member POSTs to /api/taskflow_agent_message/ targeting a DM they cannot list, and gets
  201 -- with sender_label and sender_user accepted VERBATIM from the body. Forgery plus injection
  into a private conversation, and the SSE fan-out then delivers it to the real participants.
  Not a spec violation (Task 3 was scoped to two tables) but the identical pattern, so it was
  fixed in 5b77b55 rather than filed. Mutation-proven: reverting it yields
  {"body_markdown":"forged","channel":4,"sender_label":"alice","sender_user":1} -- a message
  forged as alice inside dave's private DM.
  Also removed two dead client helpers (createTaskflowAgentChannel/Member) that called routes now
  returning 405. Zero importers, confirmed by grep on BOTH the literal table name and the
  taskflowTables constant key -- the earlier audit had only grepped the literal, so it had missed
  them rather than cleared them.

## Minor findings (for final review triage)
- rest.rs:296 comment claims "the frontend renames and archives" -- no PATCH/DELETE against
  /api/taskflow_agent_channel/{id} exists in v2_fe; archived is read-only. Keeping the verbs is
  defensible headroom, but the comment states it as current fact. Related: an active project
  member can still hard-DELETE a shared project room (cascading its messages), untested.
- taskflow_channel_read_cursor is registered TWICE (rest.rs:124 and :97). RestPlugin::resource is
  last-in-wins, and read_only is chained last, so it ends up [List,Retrieve] + PROJECT scope, not
  channel scope -- the channel_scope("channel") built for it in the chat block never runs. So DM
  read cursors are project-scoped and a member can enumerate cursors for channels they cannot see.
  PRE-EXISTING, not introduced here.
- client.d.ts typings still advertise the removed Create actions. Regenerating would make dead
  helpers fail to compile -- a cheap forcing function.
- The readability test covers List on both tables; roster Retrieve is uncovered.
- The brief's stated fear that an over-restrictive .views would "break visible_channel_ids itself"
  is NOT reachable: .views gates HTTP routing only, while visible_channel_ids reads the roster
  through the ORM directly (rest.rs:185). The test is still worth having for the frontend contract.
- Test-count baseline correction: the branch baseline was 131, not 132. 131 + 2 new = 133.

## FINAL WHOLE-BRANCH REVIEW: MERGE, after 1 in-scope fix (27c0357)
IMPORTANT I1, FIXED. Update/Delete were left on taskflow_agent_channel with the comment
"the frontend renames and archives." That justification was FALSE -- the reviewer grepped every
taskflowApi.update|remove|delete call in v2_fe and found only tasks, taskSessions and projects.
Nothing has ever PATCHed or DELETEd a channel, and `archived` is read-only in the UI.
They could not grant access (channel_scope means you can only mutate what you can already see)
but they could DESTROY: every active member sees the shared project room, so any of them could
PATCH {kind:"direct"} on it -- hiding it from every human, since ensure_project_room writes roster
rows only for AGENTS -- or DELETE it, cascading every message. Mutation-proven before the fix:
PATCH succeeded and the room vanished from read-back; DELETE returned 204 and destroyed it.
Now [List, Retrieve], matching the roster table. 135 workspace tests pass.

## CRITICAL, PRE-EXISTING, NOT CLOSED BY THIS BRANCH -- next tickets
C1. EVERY DM MESSAGE BODY IS BROADCAST OVER SSE TO EVERY PROJECT MEMBER.
    realtime.rs:202-204 routes TaskflowAgentMessage via group_for(MESSAGES) -> project:{id}:messages,
    and MESSAGE_FIELDS (realtime.rs:60-73) includes body_markdown, sender_label, sender_user.
    may_join (realtime.rs:311-337) gates that group on ACTIVE PROJECT MEMBERSHIP ONLY -- it never
    consults visible_channel_ids. CHANNEL_MEMBER_FIELDS leaks the full roster the same way.
    Bob opens the app, his client joins project:P:messages, Alice DMs Carol, and Bob's SSE stream
    receives the body. No POST, no roster row, no 405 -- he just listens. This is the SAME READ the
    entire branch exists to prevent, delivered by a different transport.
    The ledger's earlier Observation said only that CHANNEL_FIELDS leaks DM title/kind. That
    understated it by an order of magnitude: titles are metadata, body_markdown is the payload.
C2. DM ATTACHMENTS ARE READABLE PROJECT-WIDE, AND /media HAS NO ACCESS GATE AT ALL.
    taskflow_message_attachment sits in READ_ONLY_PROJECT_SCOPED_TABLES (rest.rs:90) so it gets
    project_scope, NOT channel_scope, and it exposes `file` -- the storage key. Separately
    main.rs:152 calls .media("/media","./media") and never calls media_access(...), so /media/<key>
    is served with no authentication whatsoever.
    Bob GETs /api/taskflow_message_attachment/, reads the keys for Alice and Carol's DM, and
    fetches them from any browser, logged in or not.
    The stated vulnerability was "message bodies and attachments included." Bodies are now closed
    over REST; attachments are closed over NO transport.

## Remaining Minors (triaged: all follow-up, none blocking)
- taskflow_channel_read_cursor registered twice -> effectively project-scoped, so a member can
  enumerate read receipts for DMs they cannot see (who talks to whom, and when). Fold into C1's
  ticket -- same class, strictly less severe.
- Rolled-back rows still broadcast: umbral-realtime hooks post_save, which fires on .on_tx() BEFORE
  commit, so a failed transaction emits a "channel created" event for a row that never lands.
  Near-unreachable (validation is pre-transaction) but nothing owns it.
- No DM dedup under concurrency: two simultaneous creates yield two direct channels with identical
  rosters and messages split silently between them. Pre-existing; the old two-call flow raced too.
- Empty title gives a bare 400 with no body.
- role flattening: old rows carry owner/developer, new ones always "member", so rosters render
  inconsistently between old and new channels forever. Cosmetic.
- client.d.ts typings stale; roster Retrieve uncovered by the readability test.

## Verified clean by the final reviewer
- THE SEAM IS SOUND -- the failure class that shipped two days ago does not recur. bearerHeaders()
  does set content-type: application/json; field names, casing, the kind discriminator and
  optional-vs-required all match CreateChannelInput/CreateChannelMemberInput against the exact
  payload ensureLiveChannel builds. TaskflowChannelKind is serde snake_case so "direct"/"project"
  land correctly. The response's members[] carry `id`, which is what upsertById needs.
- WRITE-PATH ENUMERATION COMPLETE. Every remaining writer of the roster table is server-side and
  derives identity: create_channel, add_channel_member, ensure_project_room (agent rows only,
  Project-kind rooms), seed/chat.rs:77. The MCP surface never touches either table.
- No orphan channels exist in the dev DB (4 channels, rosters 3/2/2/2, zero empty).
