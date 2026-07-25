# Media Page (#60 second half) — Progress Ledger

Plan: docs/superpowers/plans/2026-07-25-media-page.md
Spec: docs/superpowers/specs/2026-07-25-media-page-design.md
Branch: feat/media-page-60
Merge base: main
TaskFlow task: #60 (Dashboard half already merged; this completes it)

Frontend-only, v2_fe/. vitest node env, no jsdom (pure helpers tested; page by build+live).

## Tasks
- [x] 1  media-items.ts mapping/filter helpers + fetchProjectMedia (+ tests) — complete (commit 57c115b, review clean; 8 media-items tests, 164 total). Used REFERENCE_PAGE_SIZE + dropped redundant casts (improvements).
- [x] 2  MediaPage.tsx gallery + export AttachmentPreviewDialog + route + nav — complete (commits 9c02f97..630f424, review clean after fix; build clean, 0 new lint, 164 tests). Fixed an Important refetch-churn bug (channelName in fetch deps → refetch on every realtime event); now fetches raw rows on [projectId,retryToken] and maps at render, plus a stale-carousel-index guard.
- [ ] 3  live verification; mark #60 done

## Minor findings (for final review triage)
(none yet)

## Notes
- Reuse the chat AttachmentPreviewDialog (export it) + getAttachmentKind (@/lib/attachment-kind); do NOT fork a preview.
- Channel privacy is server-side (REST scope); no client filtering.
- Match OverviewPage's project-switch stale guard (dataProjectId → displayData).
- Restart Vite for the new route.

---
## Dashboard (first half of #60) — MERGED to main (5c8ff84) + hotfix 2e9936d
Chart bars were invisible (percentage height w/o definite parent) — fixed.
OPEN with user: operator vs assignee attribution ("Your time" reads 0m because
the agent operated the tasks; assignee is a one-line switch if they want it).
