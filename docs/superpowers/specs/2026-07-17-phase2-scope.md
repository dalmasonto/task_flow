# Phase 2 — Scope & Decomposition

**Date:** 2026-07-17
**Mandate:** Take the lead top-down. Build on `main`, committing/merging as each piece lands.
Map every frontend page to the backend, remove dummy data everywhere, adjust UI freely.
Approval gates waived by the user — proceed autonomously, report as we go, keep security work
under subagent review.

## The problem, restated

Phase 1 fixed realtime + messaging. Phase 2 closes the security and product gaps that make the
app unusable for a real multi-user workspace:

1. **No access scoping.** Every REST resource is `ResourceConfig::new(...)` under
   `default_permission(IsAuthenticated)` with no `.scope()`. Any logged-in user lists every
   project — `dalmasogembo@gmail.com` sees "TaskFlow v2" despite not being a member. The realtime
   group policy likewise admits any authenticated user to any project room.
2. **Invites don't close the loop.** `TaskflowProjectInvite` exists but there is no accept/deny
   path: an invited user cannot turn an invite into membership.
3. **No account/settings surface.** No profile page, no settings page, no user menu wired to the
   real user (`nav-user` is hardcoded to "Dalmas / workspace@taskflow.local"). Routing is flat.
4. **Dummy data everywhere.** `App.tsx` carries a full second hardcoded "TaskFlow V2" plus fake
   tasks, agents, sessions, invites, terminal transcripts. `ApiBasePage` isn't even passed live
   data. On an empty backend the UI shows seed fixtures instead of honest empty states.

## Decomposition (build order A → B → C)

### SP-A — Project access scoping (backend security) — FIRST
Scope every project-scoped REST resource to the caller's active membership, and gate the realtime
group policy the same way. This is the live security bug and the foundation the rest keys on.

- **Membership set:** `TaskflowProjectMember` rows where `user == identity.pk` AND
  `status == active` → the caller's project ids. Superuser (`identity.is_superuser`) sees all.
  Anonymous sees none.
- **`taskflow_project`:** `ScopeDecision::RestrictIn("id", my_project_ids)`.
- **Every project-scoped table** (member, invite, api_endpoint, task, task_relation, task_activity,
  task_session, agent, agent_credential, agent_session, agent_channel, agent_channel_member,
  agent_message, agent_terminal_frame): `RestrictIn("project", my_project_ids)`.
- **Exception — `taskflow_project_invite`** also needs to be visible to its *invitee* (who is by
  definition not yet a member). SP-A scopes it by project membership only; SP-B widens it to
  "project I'm a member of OR invite addressed to my email" when the accept/deny flow lands. Until
  then an invitee simply can't see the invite — acceptable, because there's no accept UI yet.
- **`taskflow_agent_credential`:** scoped like the rest, closing the Phase-1-flagged exposure of
  `key_hash` to every authenticated user (defense in depth; a later pass may also `.hide()` the
  hash field).
- **Realtime group policy:** replace "any authenticated user may join any project room" with a
  membership check — the caller may join `project:{id}:*` only if they have an active membership in
  project `{id}` (superuser: any). Presence and the projects/agents-list groups follow the same
  rule.
- **Fail closed:** any lookup error → `ScopeDecision::None`, never `All`.

**Result:** `dalmasogembo@gmail.com` (not a member) sees zero projects and can join zero rooms;
`admin` (seeded member of TaskFlow v2) sees exactly that project.

### SP-B — Account, Settings & Invitations — SECOND
> **RELEASE-BLOCKER (HIGH):** invite-accept must require `email_verified_at` once an email-verification flow exists; until then, an attacker who signs up as `victim@email` can claim a real invite sent to that address. Not hard-gated now because signup sets `email_verified_at=None` and no verification email is ever sent, so a gate would make every invite unacceptable in dev.

Backend:
- **Invite accept/deny.** Add `Declined` to `TaskflowInviteStatus` (migration). New endpoints:
  `POST /api/taskflow/projects/invites/{token}/accept` and `.../decline`. Accept: verify the
  invite's email matches the caller's account, flip `status=accepted` + `accepted_at`, and
  create/activate a `TaskflowProjectMember` (`user`, `member_key = user:{id}`, `status=active`,
  `joined_at`). Decline: `status=declined`. Both idempotent and caller-scoped.
- **Widen invite visibility:** the caller sees invites whose `email` matches their account email
  (their inbox) in addition to their project memberships.
- **User settings model.** New `TaskflowUserSettings` (`user` FK unique, `theme`, `email_notifications`,
  `default_project` nullable FK, timestamps) with REST scoped to `owner_field("user")` +
  `scope(owned_by user)`. Reuse rather than invent where the framework already has a fit; a small
  dedicated model keeps app prefs out of `admin_user_pref`.
- **Profile:** username editable via the existing `auth_user` REST (self only); email is `noedit`;
  password via the existing auth change-password route.

Frontend:
- Introduce a **nested router**: a `/dashboard` layout route with `<Outlet/>` (the sidebar/header
  shell becomes the layout), and a new `/account` area with its own nested routes: **Profile**,
  **Settings**, **Invitations** (inbox), **Security** (password).
- Wire `nav-user` + `app-sidebar` to the real authenticated user.
- Settings page reads/writes `TaskflowUserSettings`; theme actually applies.

### SP-C — Dummy-data purge, full backend mapping, UI polish — THIRD
- Delete every seed const (`projects`, `initialTasks`, `inviteRecords`, `agentDirectory`,
  `agentTerminalSessions`, `agentSessionRecords`) and the empty-backend seed fallback; replace with
  honest empty states.
- Wire the still-fake pages: `ApiBasePage` (pass live workspace → real agent sessions/credentials/
  endpoints/identity), `ActivityLogPage` (real `taskflow_task_activity`, not synthesized task
  history), board `AgentRoom`/`ActivityPanel` (real agents/activity).
- Remove the hardcoded second "TaskFlow V2" fixture and all fake ids/names/paths.
- Extract pages out of the 6.3k-line `App.tsx` into a `pages/` structure as each is touched — no
  big-bang rewrite, but leave the file materially smaller and each page in its own module.
- UI adjustments as needed for the new empty states, account section, and settings.

## Cross-cutting decisions
- **Scoping is server-side and authoritative.** The frontend never decides visibility; it renders
  what the scoped API returns. This is what makes the fix real rather than cosmetic.
- **Superuser bypass** everywhere (`is_superuser` → `All`) so `/admin` and the seeded superuser keep
  working.
- **Fail closed** on every scope lookup error.
- **Each sub-project:** implement → subagent review (security-focused for SP-A/B) → fix → commit to
  `main` → verify. Migrations only where a model genuinely changes (invite `Declined`, the settings
  model); the Phase-1 lesson about `makemigrations` static checks applies.
- **Deferred, tracked, not silently dropped:** the idempotency race on message send, the
  suffix-drift contract test the user declined, the dual lockfile, and full OAuth for the social
  buttons. These stay logged, not fixed under Phase 2 unless they block a step.
