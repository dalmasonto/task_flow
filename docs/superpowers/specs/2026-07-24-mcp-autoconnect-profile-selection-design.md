# MCP autoconnect + profile selection

**Status:** approved design, ready for planning
**Date:** 2026-07-24
**Area:** `mcp/` (the TaskFlow v2 MCP server). No backend or frontend changes.

## Problem

Two failures, both reported from real use.

### 1. The agent is offline until it calls a tool

Nothing registers a session at startup. Presence depends on the model
voluntarily calling `register_session` and `heartbeat` because
`instructions.ts` told it to — so an agent that gets straight to work never
appears in the dashboard, and one that forgets to keep heartbeating goes stale
90 seconds later.

### 2. Outside tmux, nothing connects at all

The one automatic connect path that exists is a **side effect of terminal
mirroring**. `index.ts:141` calls `startMirrorForThisAgent()`, which calls
`startMirrorWithRetry`, which resolves a tmux pane *first*:

```ts
// mirror.ts:105
if (!pane) {
  status = { state: "off", detail: "not running inside tmux — nothing to mirror" };
  return;
}
```

That early return is correct for mirroring and catastrophic for identity —
`registerSession`, the heartbeat, and the whole agent event stream (message
delivery, prompt replay, terminal keys) all live inside the `start(pane)`
callback below it. No pane means no session, no heartbeat, no messages.

A capability (presence) is smuggled inside a feature (mirroring), so the
feature's precondition became the capability's precondition.

### 3. Multiple profiles resolve silently

`config.ts:175`'s `chooseProfileName` falls back through
`arg > TASKFLOW_PROFILE > default_profile > "main"` and never reports
ambiguity. Two terminals in the same repo therefore both become the `main`
agent: one row in the dashboard, one DM inbox, one shared read cursor — the
exact collision `--mint` exists to prevent.

## Goals

- Connect on startup, in or out of tmux, without the model doing anything.
- Survive a backend that is not up yet, and one that restarts later.
- When the repo has more than one identity, make a human choose which one this
  terminal is — once per terminal, not once per reconnect.

## Non-goals

- Delivering messages into a non-tmux terminal. MCP has no server→client push,
  so outside tmux incoming messages remain pull-only via `check_messages`.
- Changing the backend agent-auth contract. Every endpoint used here exists.
- Replacing `--mint`. Creating an identity stays a human, user-token-authorized
  command; this spec only covers *choosing among* identities that exist.

## Design

### A. `connect.ts` — the connection lifecycle

A new module owns what the mirror path owns by accident today:

| Concern | Today | Proposed |
|---|---|---|
| `registerSession` | inside `start(pane)` | on startup, always |
| heartbeat | only via `startMirrorLoop` | own 30s loop, always |
| event stream | inside `start(pane)` | always; pane writes only when a pane exists |
| retry | 8 attempts, then permanently dead | capped backoff, indefinite |
| no tmux | entire path skipped | connects; mirroring off |

Mirroring becomes a layer bolted onto the session `connect` already registered.
`startMirrorLoop` keeps its current behavior and is started only when
`detectTmuxPane()` yields a pane.

**Session identifiers become profile-aware.** `defaultSessionIdentifier(pane)`
(`server.ts:38`) keys a session on the pane alone — `tmux:{host}:{pane}`, or
`{host}:{pid}` outside tmux. That breaks the moment a human switches identity,
because the backend treats an identifier as globally unique:

```rust
// backend/plugins/taskflow-agents/src/views.rs:1813
// The identifier is globally unique: a row owned by another agent is
// not ours to reconnect. 409 CONFLICT — the caller cannot claim it.
if row.agent.id() != agent.agent_id { return Err(StatusCode::CONFLICT); }
```

Selecting `bear` in a pane where `main` already registered would 409 — the
feature failing on its own core path. The profile therefore joins the
identifier (`tmux:{host}:{pane}#{profile}`), giving each identity its own row;
the abandoned one goes stale by itself inside the 90s window.

Registration remains idempotent per identifier and re-adopts the *same row id*
(`views.rs:1809-1837`), so a re-register during a backend restart does not
invalidate the session number the mirror already holds. `server.ts`'s
`ensureSession` must stop registering its own session and read the id `connect`
holds instead. One process, one session row.

**Retry policy.** Indefinite, with the same capped-and-jittered backoff
`events.ts:128` already uses (1s base, 30s ceiling, half-jittered). The
8-attempt give-up in `mirror.ts:21` is removed: starting the MCP before the
backend is a normal ordering, and "gives up permanently after ~2 minutes" is
indistinguishable from the bug being fixed. The event stream already retries
forever; connect now matches it.

**Re-registration.** A backend restart can invalidate the session row while the
process lives on. The heartbeat loop treats a `404` (session gone) or `401`
(credential rejected mid-flight) as "register again", not as a fatal error —
registration is idempotent per identifier, so re-registering re-adopts or
recreates the same one row. Any other status is logged and retried.

**Failure isolation is preserved.** `connect` never throws into the MCP
transport. A backend that is down degrades to "tools return errors, retry
continues in the background", never to a dead tool server.

**Status reporting.** `mirror.ts`'s module-level `MirrorStatus` splits in two:
`connect.ts` owns a `ConnectionStatus` and `mirror.ts` keeps reporting only on
the pane. `whoami` reports both: `{ connection: {state, detail?, attempts},
mirror: {state, pane?} }`. They are now independent — `connection: "active"`
with `mirror: "off"` is the normal non-tmux case and must not read as an error.

### B. Profile resolution gains an ambiguous outcome

`config.ts` grows a third result besides *resolved* and *throws*:

```ts
export type ProfileResolution =
  | { kind: "resolved"; profile: ResolvedProfile }
  | { kind: "ambiguous"; profiles: ProfileChoice[] }
```

Ambiguous ⟺ `profiles` has more than one entry **and** no `profile` argument
**and** no `TASKFLOW_PROFILE` **and** no sticky pick for this terminal.

**`default_profile` no longer silences the prompt** when several profiles
exist. It becomes the `recommended: true` entry in the payload instead.
Otherwise the prompt would never fire in practice: `--mint` writes new profiles
without moving `default_profile`, so it is always set.

A single-profile file is never ambiguous — the overwhelmingly common case
connects silently, exactly as today. `resolveProfile` keeps its current
signature and throwing behavior for callers that have an explicit name
(`--tmux --profile=x`, `--mint`, per-tool `profile` args).

### C. The `profile_ambiguous` contract

When ambiguous, startup connects nothing and every tool that would need an
identity returns a structured refusal instead of guessing:

```json
{
  "error": "profile_ambiguous",
  "profiles": [
    {"name": "main", "display_name": "Claude (main)", "recommended": true,  "in_use": true},
    {"name": "bear", "display_name": "Claude (bear)", "recommended": false, "in_use": false}
  ],
  "hint": "Ask your human which identity this terminal is, then call select_profile."
}
```

`in_use` means that agent already has a live session — heartbeat within the
90s liveness window, the same `AGENT_HEARTBEAT_WINDOW` contract the dashboard
uses. It is derived from one `list_agents` call made with any profile's
credential (all profiles in a file share a project, and `list_agents` is
project-scoped). If that call fails, `in_use` is omitted rather than guessed:
the picker degrades to names only, which is still enough to choose.

This is the MCP equivalent of a typed error. The server cannot prompt a human,
but it can return a machine-readable refusal naming the exact follow-up call
that resolves it.

**New tool `select_profile(profile)`.** Validates the name against the file,
persists the sticky record (§D), runs the full connect (§A), and returns a
`whoami`-shaped result. An unknown name returns a clear error listing the
available profiles — the same text `resolveProfile` already produces.

### D. Sticky selection

`.taskflow/sessions.json` (the directory exists and its `.gitignore` is already
`*`):

```json
{
  "terminals": {
    "tmux:%0":                  { "profile": "bear", "chosen_at": "2026-07-24T09:12:00Z" },
    "cwd:9f2a1c:48122":         { "profile": "main", "chosen_at": "2026-07-24T09:20:00Z" }
  }
}
```

Key derivation mirrors `defaultSessionIdentifier`: `tmux:{pane}` under tmux,
else `cwd:{short-hash-of-cwd}:{ppid}` — the parent pid is the MCP client
(Claude Code), stable for the life of a session. Entries older than 30 days are
pruned on write, so the file cannot grow without bound across pane churn.

Writes are best-effort: a read-only checkout loses stickiness (the human is
asked again next start) but must never fail the connect.

Precedence becomes: `profile` argument > `TASKFLOW_PROFILE` > sticky pick >
(single profile) > **ambiguous**.

### E. Instructions

`instructions.ts` currently says:

> On connect: call **whoami** first …, then **register_session** and
> **heartbeat** so humans see you online. Send **heartbeat** periodically.

That ritual is obsolete — presence is automatic — and actively harmful, since
it teaches the model to do work the server now owns. Replace with:

- Connection, presence and heartbeat are automatic; `whoami` *confirms* rather
  than establishes.
- If any tool returns `profile_ambiguous`, ask your human which identity this
  terminal is (surfacing `display_name`, which one is `recommended`, and which
  are already `in_use`), then call `select_profile`. **Never guess a profile.**

`register_session` and `heartbeat` remain registered tools — they still serve
explicit `idle`/`busy` status hints — but stop being startup obligations.

## Error handling

| Situation | Behavior |
|---|---|
| Backend down at startup | Retry forever with capped backoff; tools return the backend error meanwhile |
| Backend restarts later | Existing event-stream reconnect plus the heartbeat loop re-registering on 404/401 |
| No tmux | `connection: active`, `mirror: off`. Not an error, not logged as one |
| `.taskflow.json` missing/invalid | Unchanged: clear stderr message, exit non-zero |
| Ambiguous profile | No connect, `profile_ambiguous` from tools, no retry storm |
| `select_profile` with unknown name | Error listing available profiles; nothing persisted |
| Sticky store unreadable/unwritable | Ignored; falls back to asking |
| `list_agents` fails during ambiguity | `in_use` omitted; names still offered |
| Switching profile inside one pane | Distinct profile-suffixed identifiers, so no 409; the old row goes stale in 90s |

## Testing

All unit-testable without a backend, following the existing seam style
(injected clock, fake client, explicit `env`/`startDir` options).

- **`config.test.ts`** — the ambiguity matrix: one profile, many profiles, an
  explicit argument, `TASKFLOW_PROFILE`, a sticky pick, and `default_profile`
  set with several profiles (must still be ambiguous).
- **`sessions-store.test.ts`** (new) — key derivation in and out of tmux,
  round-trip read/write, age pruning, unreadable and unwritable files.
- **`connect.test.ts`** (new) — registers exactly once; heartbeats on the fake
  clock; **connects with no pane**; retries past the old 8-attempt boundary;
  never throws; reports status transitions.
- **`server.test.ts`** — a tool called while ambiguous returns
  `profile_ambiguous` and performs no HTTP; `select_profile` connects and makes
  subsequent tools work; an unknown name is rejected.
- **`instructions.test.ts`** — asserts the startup ritual is gone and the
  ambiguity protocol is present, matching the registered tool set.

Manual verification, since both reported symptoms are cold-start behavior that
unit tests structurally cannot catch (the lesson from the last dogfood round):

1. Run the MCP outside tmux → dashboard shows the agent online.
2. Start the MCP with the backend stopped, then start the backend → agent comes
   online without touching the MCP.
3. `--mint` a second profile, reconnect → the agent is asked which identity it
   is; pick one; reconnect again → no second prompt, same identity.

## Migration and compatibility

No config format change: `.taskflow.json` is read exactly as before. A
single-profile file behaves identically to today. Existing per-tool `profile`
arguments and `TASKFLOW_PROFILE` keep their current precedence and bypass the
prompt entirely, so scripted and CI uses are unaffected. `.taskflow/sessions.json`
is created lazily and is local-only.
