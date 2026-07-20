# Design: trusted channel creation

**Date:** 2026-07-20
**Status:** draft, for review

## Problem

The DM privacy fix that landed in `e130d91` can be bypassed with one request.

`visible_channel_ids` (`backend/src/rest.rs`) decides who may see a direct
channel by reading the roster:

```
shared rooms → any active member of the project
DMs          → only if a roster row links the caller to that channel
```

That logic is correct. The problem is where roster rows come from.
`taskflow_agent_channel_member` is registered for auto-REST with **no action
restriction** (`rest.rs:282-285`), so `Create` is exposed:

```http
POST /api/taskflow_agent_channel_member/
{ "channel": 3, "user": <self>, "member_kind": "user", "project": 2 }
```

`visible_channel_ids` then honours that row. One POST and the caller is reading
a DM they were locked out of a moment earlier — message bodies, attachments,
everything.

**A permission check that reads from a table the caller can write to is not a
permission check.** `scope_async` governs reads only — it filters which rows come
back from list/retrieve/update/delete and does not touch create. The lock is
sound; the key is on the floor beside it.

This is not a new class of bug here. `rest.rs` already documents the identical
vector for `taskflow_project_member` and made that table read-only for exactly
this reason: otherwise any authenticated user could POST themselves an active
membership, and the read scope would honour that too.

There is also a second claim in the codebase that this registration makes false.
`urls.rs` describes `POST /api/taskflow/channels/{channel}/members` as *"the only
authorized way to add a person to a channel roster."* It is not.

## Why the obvious fix does not work

Restricting the table to `.views([List, Retrieve])` closes the hole and **breaks
channel creation entirely**. Two independent blockers, both verified:

**1. The trusted member endpoint cannot add agents.**

```rust
pub struct AddChannelMemberInput { pub user: i64 }
// "Agents are out of scope: this endpoint adds people (`user`), never agents."
```

The frontend's `ensureLiveChannel` adds agents (`addAgent`) — that is how an
agent DM gets its roster. With the table read-only and no agent path, agent DMs
cannot be created at all.

**2. The trusted member endpoint cannot bootstrap a new DM.**

Its DM carve-out requires the caller to already be on the roster:

```rust
if channel.kind == TaskflowChannelKind::Direct {
    // caller must have a roster row for this channel, else 403
}
```

A freshly created DM has an empty roster, so nobody — including its creator —
can add themselves. The endpoint can add a second person to an existing DM; it
can never start one.

## The shape

The codebase already contains the answer one table over. `project_resource()`
strips `create` from auto-REST with this reasoning:

> an auto-REST create inserts a `taskflow_project` row but NO
> `TaskflowProjectMember` row … so an auto-REST-created project was an orphan
> invisible to its own creator. Projects are now created only through the
> authorized `POST /api/taskflow/projects` endpoint, which atomically creates the
> project and an active owner membership.

Channels have the identical shape: a row that is meaningless without its
membership, currently created in two client-controlled steps. Same disease, same
cure.

## Endpoint

`POST /api/taskflow/channels`, `RequireAuth`-gated.

```jsonc
{
  "project": 2,
  "kind": "direct" | "project" | "task" | "incident",
  "title": "Design review",
  "topic": "optional",
  "task": 7,                   // optional; for task-scoped rooms
  "members": [                 // the OTHER participants; the caller is implicit
    { "kind": "user",  "user": 3 },
    { "kind": "agent", "agent": 1 }
  ]
}
```

Returns the created channel with its roster, so the client needs one round trip
rather than a create plus N member writes.

## Authorization

Mirrors `add_channel_member` so the two cannot drift:

| Rule | Failure |
|---|---|
| Caller is an active member of the named project | 403 |
| Each target user is an active member of that project | 400, `not_a_project_member` envelope |
| Each target agent belongs to that project | 400 |
| **The caller is always added to the roster** | — |

Auto-adding the caller is what dissolves the bootstrap problem: nobody adds
themselves to an empty DM, creation does it.

`members` may be empty — a channel with only its creator is legal, which is the
create-then-invite flow for shared rooms.

Nothing about identity is a body field. The caller comes from the token; the
project is validated against the caller's memberships rather than trusted.

## Atomicity

One `umbral::transaction`, every insert `.on_tx(tx)`, exactly as `create_project`
does. The channel and its roster land together or not at all.

This fixes a real bug that exists today independent of the security hole:
`ensureLiveChannel` creates the channel and *then* writes members, so a failed
member write leaves an orphan channel — present in the database, invisible to its
own creator through `visible_channel_ids`, and impossible to join because
`add_channel_member`'s DM carve-out needs a roster row that was never written.

## Auto-REST changes (`rest.rs`)

| Table | Change | Why |
|---|---|---|
| `taskflow_agent_channel` | `.views([List, Retrieve, Update, Delete])` | Create stripped, matching `project_resource()`. Update/Delete stay so the frontend can rename and archive, still row-scoped. |
| `taskflow_agent_channel_member` | `.views([List, Retrieve])` | The actual hole. Roster rows now come only from channel creation or the trusted `add_channel_member`. |

Both remain readable, so the frontend keeps listing channels and rosters exactly
as it does now.

## Frontend

`ensureLiveChannel` (`v2_fe/src/App.tsx`) collapses from
`createTaskflowAgentChannel` followed by `Promise.all(memberWrites)` to a single
`createTaskflowChannel(...)` call.

Net simplification: the `addUser` / `addAgent` / `added` Set bookkeeping goes
away, and with it a latent bug — `addUser` silently returns when `currentUser?.id`
is falsy, so a member is dropped with no error when the current user has not
loaded yet.

## `add_channel_member` is unchanged

Its DM carve-out is correct for adding a *third* person to an existing DM: you
must already be on a private conversation to widen it. The bootstrap gap was only
ever about creation, which this endpoint now owns.

## Testing

`backend/tests/rest_scope.rs` already has the harness — `make_user`,
`make_project`, `make_member`, `get_as(user, is_super, path)`, `post_as`.

**The hole itself**
- [ ] A project member POSTing themselves onto another member's DM roster is refused
- [ ] After that refusal, the DM is still absent from their channel list
- [ ] Auto-REST create on `taskflow_agent_channel` is refused

**The endpoint**
- [ ] Caller lands on the roster of a channel they create
- [ ] A non-member of the project → 403
- [ ] A target who is not an active project member → 400
- [ ] An agent from another project as target → 400
- [ ] A DM created this way is visible to both participants and to nobody else
- [ ] `members: []` yields a channel with just the caller

**Atomicity**
- [ ] A create that fails partway leaves no channel row behind

## Out of scope

- Group DMs with more than two participants. `kind: "direct"` accepts any roster
  size; whether that should be constrained is a product question, not a security
  one.
- The `application/octet-stream` MIME on agent-uploaded attachments.
- `planning/spec-message-delivery.md` — the read-cursor delivery bug.

## Provenance

Found 2026-07-20 while reviewing the uncommitted `rest.rs` scoping change that
became `e130d91`. The scoping fix is correct; this closes the write path that
would otherwise let anyone opt into the rows it trusts.
