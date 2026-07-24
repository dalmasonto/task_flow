# GitHub Social Login — Progress Ledger

Plan: docs/superpowers/plans/2026-07-25-github-social-login.md
Spec: docs/superpowers/specs/2026-07-25-github-social-login-design.md
Branch: feat/github-social-login
Merge base: main
Pre-work restore point: 8922bf4

All work is in `v2_fe/`. Run commands from `/home/dalmas/E/projects/local_task_tracker/v2_fe`.
vitest is NODE env — no jsdom, no component tests. Test pure logic only.

## Tasks
- [x] 1  oauthLoginUrl + fetchOAuthProviders (taskflow-api.ts) — complete (commit 84c4731, review clean; 13 github-api tests, 140 total)
- [x] 2  Pre-render token consumer + parseOAuthRedirect/takeOAuthError (auth-api.ts, main.tsx) — complete (commit 6c17209, review clean; 8 auth-api tests, 148 total)
- [x] 3  Real SocialAuthButtons + GitHub mark + error notice (App.tsx) — complete (commits d9ce226..24f61c7, review clean; UI, no unit tests by design; 148 tests, eslint 3 baseline/0 new). Fixed: OAuth-error read moved from a useState initializer (unsound purity violation) to a mount effect with scoped eslint-disable.
- [x] 4  Verify full flow — automated + scriptable green: 148 tests, build clean, dist/ rebuilt (button now live), live /oauth/providers returns github only, built bundle contains the login wiring. Manual GitHub round-trip + denial + connect-flow-unaffected handed to user (needs a browser).

## Minor findings (for final review triage)
- Task 2 (Minor, within brief): `consumeOAuthRedirect`'s `history.replaceState`
  strips the WHOLE query string, not just token/error params. Harmless today —
  it only runs on a callback landing to `/dashboard/board`, which carries no other
  query. Would matter only if an OAuth callback were ever routed through a path
  that also carries unrelated query params.

## Notes
- Return target is /dashboard/board, NOT /login (auth form renders before the
  auth check → an authed user would be stranded on /login).
- Token must land only in AUTH_TOKEN_KEY ("taskflow.auth.token").
- Do NOT touch the connect flow (githubConnectUrl, SettingsPage) or backend.
- eslint baseline is already dirty (~10 pre-existing errors); compare against
  that, not 0.

---

## Previous plan (completed + merged): MCP autoconnect + profile selection
Merged to main (cc1b8c4). One tracked follow-up: ppid-reuse sticky false-positive
in mcp/src/sessions-store.ts (cwd:<hash>:<ppid> key, 30-day retention).
