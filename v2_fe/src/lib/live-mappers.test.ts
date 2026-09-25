import { describe, expect, it } from "vitest"
import { countOnlineAgents, formatFullDate, formatLiveDate, formatMessageTime, isSessionLive, mapLiveActivityEvents, mapLiveChannelMessages } from "./live-mappers"
import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import type { TaskflowAgentMessage } from "@/api/client"

function workspaceWithMessages(messages: TaskflowWorkspace["agentMessages"]): TaskflowWorkspace {
  return {
    agentMessages: messages,
    channelReadCursors: [],
    messageAttachments: [],
  } as unknown as TaskflowWorkspace
}

/// One activity row naming task 42. Cast rather than spelled out column by
/// column: these tests are about how a title is RESOLVED, not about the row.
function activityEvent(task: number | null) {
  return {
    id: 7,
    project: 1,
    task,
    actor_kind: "user",
    actor_user: null,
    actor_agent_id: null,
    actor_label: "dalmas",
    action: "status_changed",
    body_markdown: null,
    metadata_json: null,
    created_at: "2026-09-20T10:00:00Z",
  } as unknown as TaskflowWorkspace["taskActivity"][number]
}

function workspaceWithActivity(events: TaskflowWorkspace["taskActivity"]): TaskflowWorkspace {
  return { taskActivity: events, project: { id: 1, name: "Board" } } as unknown as TaskflowWorkspace
}

/// A board task row, by id and title only — the mapper reads nothing else.
function boardTask(id: string, title: string) {
  return { id, title } as unknown as Parameters<typeof mapLiveActivityEvents>[1][number]
}

const designRow: TaskflowAgentMessage = {
  id: 1,
  project: 1,
  channel: 7,
  task: null,
  client_nonce: null,
  sender_kind: "agent",
  sender_user: null,
  sender_agent: 3,
  target_agent: null,
  targets: null,
  sender_label: "claude",
  body_markdown: 'tighten this\n\n```design-ref\n{"pagePath":"pages/home.js"}\n```',
  priority: "normal",
  is_design: true,
  edited_at: null,
  created_at: "2026-09-20T10:00:00Z",
}

describe("mapLiveChannelMessages — design", () => {
  it("surfaces isDesign, parses designRef, and strips the block from body (posted row)", () => {
    const workspace = workspaceWithMessages([designRow])
    const messages = mapLiveChannelMessages(workspace, 7, "design", null)

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.isDesign).toBe(true)
    expect(msg.designRef?.pagePath).toBe("pages/home.js")
    expect(msg.body).toBe("tighten this")
  })

  it("defaults isDesign to false and designRef to null when the row has no design-ref block", () => {
    const workspace = workspaceWithMessages([{ ...designRow, is_design: false, body_markdown: "just chatting" }])
    const messages = mapLiveChannelMessages(workspace, 7, "design", null)

    expect(messages[0].isDesign).toBe(false)
    expect(messages[0].designRef).toBeNull()
    expect(messages[0].body).toBe("just chatting")
  })

  it("surfaces isDesign, parses designRef, and strips the block from body (pending row)", () => {
    const pendingRow = {
      client_nonce: "nonce-1",
      body_markdown: 'tighten this\n\n```design-ref\n{"pagePath":"pages/home.js"}\n```',
      priority: "normal" as const,
      channel: 7,
      status: "pending" as const,
      is_design: true,
    }
    const workspace = workspaceWithMessages([pendingRow])
    const messages = mapLiveChannelMessages(workspace, 7, "design", null)

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg.isDesign).toBe(true)
    expect(msg.designRef?.pagePath).toBe("pages/home.js")
    expect(msg.body).toBe("tighten this")
  })
})

describe("mapLiveActivityEvents — task titles", () => {
  // The activity route's case: no task rows are loaded there (the board's five
  // column queries are not its business), so the title comes from the id-keyed
  // map the feed fetched for exactly these rows.
  it("resolves a title from the id-keyed map when no task rows are loaded", () => {
    const events = mapLiveActivityEvents(workspaceWithActivity([activityEvent(42)]), [], { 42: "Fix the thing" })
    expect(events[0].title).toBe("Fix the thing")
    expect(events[0].taskLabel).toBe("Fix the thing")
  })

  // The board route's case: the loaded row is the richer source, so it wins.
  it("prefers the loaded task row over the map", () => {
    const events = mapLiveActivityEvents(
      workspaceWithActivity([activityEvent(42)]),
      [boardTask("42", "From the board")],
      { 42: "Stale map copy" }
    )
    expect(events[0].title).toBe("From the board")
  })

  // A title we could not resolve is UNKNOWN, not empty: the fallback names the
  // task rather than rendering a blank cell.
  it("falls back to the numeric id when neither source has the task", () => {
    const events = mapLiveActivityEvents(workspaceWithActivity([activityEvent(99)]), [], { 42: "Not this one" })
    expect(events[0].title).toBe("Task #99")
    expect(events[0].taskLabel).toBe("Task #99")
  })

  // Activity that belongs to the project rather than a task keeps its own
  // fallback, which the title map must not shadow.
  it("labels project-level activity with the project name", () => {
    const events = mapLiveActivityEvents(workspaceWithActivity([activityEvent(null)]), [], { 42: "Fix the thing" })
    expect(events[0].title).toBe("Board")
    expect(events[0].taskLabel).toBeNull()
  })
})

/// A row that differs from `activityEvent` only in the two fields ORDERING is
/// decided by, so a wrong order cannot be blamed on anything else.
function activityRow(id: number, createdAt: string) {
  return { ...activityEvent(null), id, created_at: createdAt } as unknown as TaskflowWorkspace["taskActivity"][number]
}

describe("mapLiveActivityEvents — newest first", () => {
  // The bug the mapper's sort exists for, as a regression test: the fetch
  // arrives newest-first but a realtime upsert APPENDS, so without the re-sort
  // a live row sat at the END of the list — and the feed is paged from the top,
  // so a fresh event never appeared. The expected order is written out rather
  // than asserted as "is sorted": restating the comparator would pass even if
  // the ordering were the wrong one.
  it("puts an appended live row above a newest-first fetched list", () => {
    const fetched = [
      activityRow(300, "2026-09-25T12:00:00Z"),
      activityRow(299, "2026-09-25T11:59:00Z"),
      activityRow(298, "2026-09-25T11:58:00Z"),
    ]
    // What upsertCapped leaves behind: live rows appended in arrival order,
    // both newer than everything fetched.
    const appended = [activityRow(400, "2026-09-25T12:05:00Z"), activityRow(401, "2026-09-25T12:06:00Z")]

    const events = mapLiveActivityEvents(workspaceWithActivity([...fetched, ...appended]), [])

    expect(events.map((event) => event.id)).toEqual(["401", "400", "300", "299", "298"])
  })

  // The tiebreak half of that guarantee: at the same instant the higher id is
  // the newer event, so the appended row still has to come first.
  it("orders rows that share a timestamp by descending id", () => {
    const at = "2026-09-25T12:00:00Z"
    const events = mapLiveActivityEvents(
      workspaceWithActivity([activityRow(300, at), activityRow(401, at), activityRow(299, at)]),
      []
    )

    expect(events.map((event) => event.id)).toEqual(["401", "300", "299"])
  })
})

describe("mapLiveActivityEvents — the task index", () => {
  // The per-event `find` became one index built per call. `find` returned the
  // FIRST matching row, so a board carrying the same live id twice must still
  // resolve to the first — a faster lookup may not change which row wins.
  it("resolves a duplicated task id to the first board row, as find did", () => {
    const events = mapLiveActivityEvents(workspaceWithActivity([activityEvent(42)]), [
      boardTask("42", "First"),
      boardTask("42", "Second"),
    ])

    expect(events[0].title).toBe("First")
  })

  // A row whose id is not a live id cannot match a numeric `event.task` —
  // `liveId` answers null for it, and the index must skip it rather than key it
  // under something a later lookup could hit.
  it("ignores a board row whose id is not a live id", () => {
    const events = mapLiveActivityEvents(workspaceWithActivity([activityEvent(42)]), [boardTask("local-1", "Local")])

    expect(events[0].title).toBe("Task #42")
  })
})

describe("the date formatters the feed renders with", () => {
  // The three patterns are built once now instead of once per row — that
  // construction was ~75% of an activity recompute. A cache is only sound if it
  // is INVISIBLE, so each formatter must still produce exactly what a freshly
  // constructed one produces.
  const iso = "2026-09-25T12:34:00Z"

  it("formatLiveDate matches a freshly constructed formatter", () => {
    const fresh = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    expect(formatLiveDate(iso)).toBe(fresh.format(new Date(iso)))
  })

  it("formatMessageTime matches a freshly constructed formatter", () => {
    const fresh = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    expect(formatMessageTime(iso)).toBe(fresh.format(new Date(iso)))
  })

  it("formatFullDate matches a freshly constructed formatter", () => {
    const fresh = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })
    expect(formatFullDate(iso)).toBe(fresh.format(new Date(iso)))
  })

  // A missing or unparseable value is the same "unknown, not absent" rule the
  // title fallback follows — the fallback still has to come back, not "Invalid
  // Date".
  it("keeps the fallbacks for a missing or unparseable value", () => {
    expect(formatLiveDate(null)).toBe("Live")
    expect(formatLiveDate("not a date", "Live")).toBe("Live")
    expect(formatMessageTime(null)).toBe("Live")
    expect(formatFullDate(null)).toBe("")
  })
})

describe("countOnlineAgents — the sidebar's badge", () => {
  const now = Date.parse("2026-09-25T12:00:00Z")
  const live = new Date(now - 5_000).toISOString()
  const stale = new Date(now - 600_000).toISOString()

  function agent(id: number, status: string, lastSeen: string) {
    return { id, project: 1, status, last_seen_at: lastSeen } as unknown as TaskflowWorkspace["agents"][number]
  }

  function workspace(agents: TaskflowWorkspace["agents"], agentSessions: TaskflowWorkspace["agentSessions"]) {
    return { agents, agentSessions } as unknown as TaskflowWorkspace
  }

  it("counts an agent whose own row is live and heartbeating", () => {
    expect(countOnlineAgents(workspace([agent(1, "connected", live)], []), now)).toBe(1)
    expect(countOnlineAgents(workspace([agent(1, "connected", stale)], []), now)).toBe(0)
  })

  // Item 6 as a regression test. `agentSessions` is the presence SLICE — it
  // loads on the API-Base page and in the task sheet, and nowhere else. When the
  // badge counted it, an agent with a live session but a stale roster row turned
  // green as a side effect of visiting an unrelated page, and the sidebar showed
  // two different numbers for the same project. Passing the sessions must change
  // nothing.
  it("does not move when the presence slice loads", () => {
    const agents = [agent(1, "connected", live), agent(2, "offline", stale)]
    const withoutSessions = countOnlineAgents(workspace(agents, []), now)
    const withSessions = countOnlineAgents(
      workspace(agents, [
        {
          id: 5,
          project: 1,
          agent: 2,
          status: "connected",
          last_seen_at: live,
        } as unknown as TaskflowWorkspace["agentSessions"][number],
      ]),
      now
    )
    expect(withoutSessions).toBe(1)
    expect(withSessions).toBe(withoutSessions)
    // The session itself IS live by the shared definition — the point is that
    // this badge is not what reads it.
    expect(isSessionLive({ status: "connected", last_seen_at: live }, now)).toBe(true)
  })
})
