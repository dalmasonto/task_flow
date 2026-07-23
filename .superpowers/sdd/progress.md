# GitHub Mirror Affordance — Progress Ledger

Plan: docs/superpowers/plans/2026-07-23-github-activity-affordance.md
Spec: docs/superpowers/specs/2026-07-23-github-activity-affordance-design.md
Branch: feat/github-linking-25
Merge base: main
Pre-work restore point: d8bf545

## Tasks
- [x] 1  githubMirrorState resolver + tests (lib, TDD)
- [x] 2  Per-activity-row post button
- [x] 3  Activity section banner + extracted publish handler
- [x] 4  Composer checkbox reads the resolver

## Minor findings (for final review triage)
- Task 2: the plan's "npm run lint exits 0" expectation is wrong — the repo's lint
  baseline is already dirty (10 errors / 1 warning) at HEAD, all pre-existing
  react-hooks/set-state-in-effect + fast-refresh hits in App.tsx:1951/2013/2466/4560/8401,
  SettingsPage, message-attachments, markdown-renderer, client.d.ts. Verified by
  stashing App.tsx: identical 11 problems with and without the change. Tasks 3-4
  should compare against 10 errors, not 0.
- Task 2: manual in-app verification (plan step 5) deferred — batching it with the
  Task 4 / verification-matrix pass instead of starting the dev server three times.
- All 4 tasks: automated verification is GREEN — `npx tsc -b` exits 0, `npm run test`
  is 83 passed / 12 files. Lint compared against the dirty baseline, not 0.
- OUTSTANDING: the manual verification matrix has NOT been run. No browser tool is
  available in this session, so the visual states were never observed. Backend (:8000)
  and vite (:5173) are both up and ready for a human pass.
- Matrix correction (read-only sqlite check of backend.db, 2026-07-23): the plan's
  matrix says task 53 (issue #1) demonstrates `ready`. It does not — `taskflow_github_pref`
  has post_as_me=0 for user 1 on project 2, so task 53 currently renders `not_permitted`.
  Reaching `ready` needs "post as me" turned on at /dashboard/api first.
  Live state: project 1 "Umbral" github_repo=NULL (`not_linked`); project 2 "TaskFlow v2"
  linked to dalmasonto/task_flow, github_auto_mirror=0; only task 53 has an issue.
  So three rows — not_linked, unpublished, not_permitted — are observable with zero
  DB edits, and auto/ready are reachable via the /dashboard/api toggles (no sqlite
  surgery needed, contrary to the plan's "edit backend.db between checks").
