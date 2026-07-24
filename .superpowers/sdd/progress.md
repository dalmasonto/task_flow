# MCP Autoconnect + Profile Selection — Progress Ledger

Plan: docs/superpowers/plans/2026-07-24-mcp-autoconnect-profile-selection.md
Spec: docs/superpowers/specs/2026-07-24-mcp-autoconnect-profile-selection-design.md
Branch: feat/mcp-autoconnect-profiles
Merge base: main
Pre-work restore point: d8fb8f7

All work is in `mcp/`. Run commands from `/home/dalmas/E/projects/local_task_tracker/mcp`.

## Tasks
- [ ] 1  Per-terminal sticky profile store (src/sessions-store.ts)
- [ ] 2  Ambiguous profile resolution (src/config.ts)
- [ ] 3  Profile-aware session identifiers (src/session-identifier.ts)
- [ ] 4  Connection lifecycle (src/connect.ts)
- [ ] 5  Extract agent runtime from index.ts (src/runtime.ts) — pure move
- [ ] 6  Startup wiring — connect first, mirror second (src/index.ts)
- [ ] 7  profile_ambiguous refusals + select_profile (src/server.ts)
- [ ] 8  Rewrite agent instructions (src/instructions.ts)
- [ ] 9  Build, install, verify against a real backend

## Minor findings (for final review triage)
(none yet)

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
