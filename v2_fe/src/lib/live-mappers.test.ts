import { describe, expect, it } from "vitest"
import { countOnlineAgents, isSessionLive, mapLiveActivityEvents, mapLiveChannelMessages } from "./live-mappers"
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
