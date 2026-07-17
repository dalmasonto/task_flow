# Realtime + Messaging Rework — Progress Ledger

Plan: docs/superpowers/plans/2026-07-17-realtime-messaging.md
Branch: realtime-messaging
Merge base: main
Pre-work restore point: 374df9d

## Tasks
- [x] 1  Model changes (client_nonce, ChannelMember.project)
- [ ] 2  Send endpoint
- [ ] 3  Realtime per-table groups
- [ ] 4  Seed chat workspace
- [ ] 5  Regenerate client
- [ ] 6  FE api layer (groups, subs, send)
- [ ] 7  Reconcile reducer + vitest
- [ ] 8  App.tsx collapse
- [ ] 9  File picker
- [ ] 10 End-to-end verification

## Minor findings (for final review triage)

## Log
Task 1: complete (commits d644e80..2c00d0c, review clean — both verdicts PASS)
  Deviation (reviewer-validated): plan's "recreate dev DB" was wrong. makemigrations rejects a
  NOT NULL FK ALTER via a static UnsafeAlter check regardless of row count. Fix: regenerated the
  plugin's only migration (0001_auto.json) so both columns land in the initial CREATE TABLE.
  Sound only pre-production; spec updated to say so.
