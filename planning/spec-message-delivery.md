# Spec: fix message delivery losing messages

**Status:** draft, for review
**Found:** 2026-07-19, during MCP smoke test
**Evidence:** message #56 lost in project 2, channel 3

## Problem

Message #56 ("Hi I would want you to run another taskflow command", 02:39:03Z)
was never surfaced to the agent, but `read_cursor` advanced past it to 57.
The message was marked read without being delivered, and by design it is
never redelivered.

It was only recovered by noticing a gap in message ids and re-querying with
`unread_only=false`. Nothing in the normal read path would have surfaced it.

### Root cause

`read_cursor` is one field doing two incompatible jobs:

1. **transport high-water mark** — how far the SSE bridge has streamed
2. **agent processed mark** — how far the agent has actually read and acted

These agree until delivery drops something, which is precisely the moment the
distinction matters. The bridge advances the cursor on *fetch*, so a fetched
-but-undelivered message is indistinguishable from a handled one.

### Observable symptom

`check_messages` returns a self-contradictory payload:

```json
{ "read_cursor": 57, "unread_count": 3 }
```

Two subsystems disagreeing about what has been read.

## Proposed fix

**The bridge must not own the read cursor.**

- Delivery becomes idempotent — the bridge may re-push a message it already
  pushed, and that is not an error.
- Only `mark_read` advances `read_cursor`, called by the agent *after* acting.
  This is already what the `check_messages` docstring prescribes; the bridge
  currently violates it.
- If a transport-side position is genuinely needed, add a separate
  `delivery_cursor` rather than overloading the read one.

### Consequence

At-least-once instead of at-most-once. An agent may occasionally see a
message twice. That is strictly better than silently losing one — a duplicate
is visible and harmless, a drop is invisible and unrecoverable.

## Acceptance criteria

- [ ] A message fetched by the bridge but not delivered stays unread
- [ ] `read_cursor` only ever moves via an explicit `mark_read` call
- [ ] `read_cursor` and `unread_count` are never mutually contradictory
- [ ] Regression test: drop a message mid-delivery, assert it is redelivered
- [ ] Regression test: `check_messages` twice without `mark_read` returns the
      same unread set both times

## Open question

Should the bridge auto-`mark_read` once the agent *responds* in-channel?
Convenient, but it reintroduces the same coupling through a side door.
Recommend no.
