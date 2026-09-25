import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  fetchChannelMessages,
  fetchTaskflowProjectSummary,
  fetchTaskflowWorkspace,
  fetchTaskTitles,
  fetchWorkspaceChannels,
  fetchWorkspaceChat,
  taskflowTables,
} from "./taskflow-api"

/// The loader layer had no test file at all, which is how the request SHAPES
/// below — the page walk, the sparse fieldsets, the id-keyed title lookup — went
/// in without anything able to notice if they were undone. These tests stub
/// `fetch` and assert the requests the app actually makes.
///
/// What they do NOT cover: any rendering or gating that consumes the results.
/// The gate decisions are tested in live-slices.test.ts, and the surfaces that
/// read `agentChannelsLoaded` are components, which have no DOM here — the chat
/// dock's unknown-list states are pinned as MARKUP instead
/// (components/chat/chat-dock.test.ts).

type ScriptedTable = { rows: unknown[]; count?: number; pageSize?: number }

/// The paginated envelope the backend emits (`PageNumberPagination`).
function envelope(rows: unknown[], count: number, page: number, pageSize: number) {
  return new Response(
    JSON.stringify({
      results: rows,
      count,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
      current_page: page,
      page_size: pageSize,
      next: page < Math.ceil(count / pageSize) ? page + 1 : null,
      previous: page > 1 ? page - 1 : null,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}

/// Serve canned rows per table, honouring `page` / `page_size` / `id__in` the way
/// the server does. Records every requested path + query so a test can assert
/// what was ASKED, which is the whole point here.
function stubApi(tables: Record<string, ScriptedTable>) {
  const requested: string[] = []
  const fetchMock = vi.fn((input: unknown) => {
    const url = new URL(String(input), "http://test")
    requested.push(`${url.pathname}?${url.searchParams.toString()}`)
    const table = url.pathname.replace(/^\/api\//, "").replace(/\/+$/, "")
    const script = tables[table]
    if (!script) return Promise.resolve(envelope([], 0, 1, 25))
    // `?id__in=` is the one filter these tests depend on, so the stub applies it:
    // a chunked lookup must come back with only the ids that chunk asked for.
    const idIn = url.searchParams.get("id__in")
    const rows = idIn
      ? script.rows.filter((row) => idIn.split(",").includes(String((row as { id: number }).id)))
      : script.rows
    const count = idIn ? rows.length : (script.count ?? rows.length)
    const page = Number(url.searchParams.get("page") ?? "1")
    const pageSize = Number(url.searchParams.get("page_size") ?? "25")
    const start = (page - 1) * pageSize
    return Promise.resolve(envelope(rows.slice(start, start + pageSize), count, page, pageSize))
  })
  vi.stubGlobal("fetch", fetchMock)
  return {
    requested,
    /// Every request made against one table, in order.
    for: (table: string) => requested.filter((entry) => entry.startsWith(`/api/${table}/`)),
  }
}

function searchOf(entry: string): URLSearchParams {
  return new URLSearchParams(entry.slice(entry.indexOf("?") + 1))
}

const channel = (id: number) => ({ id, project: 1, title: `channel ${id}`, kind: "project", archived: false })

beforeEach(() => {
  // `getStoredToken()` reads localStorage on every request; in this environment
  // there is no `window` at all, so the loaders need the one property they use.
  vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem: () => {} } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("fetchWorkspaceChannels", () => {
  it("asks for one page per table when the project's channels fit", async () => {
    const api = stubApi({
      [taskflowTables.agentChannels]: { rows: [channel(1), channel(2)], count: 2 },
      [taskflowTables.agentChannelMembers]: {
        rows: [
          { id: 5, channel: 1, member_kind: "user", display_name: "dalmas" },
          { id: 6, channel: 2, member_kind: "agent", display_name: "claude" },
        ],
        count: 2,
      },
    })
    const slice = await fetchWorkspaceChannels(7)
    expect(api.for(taskflowTables.agentChannels)).toHaveLength(1)
    expect(api.for(taskflowTables.agentChannelMembers)).toHaveLength(1)
    expect(slice.agentChannels.map((row) => row.id)).toEqual([1, 2])
    expect(slice.agentChannelMembers.map((row) => row.id)).toEqual([5, 6])
  })

  // A channel list rendered as the project's rooms must be the whole list: the
  // rail resolves "the project room" from it, and a prefix of it is how a real
  // room goes missing. This is the walk, and mutating the loader back to a
  // single page-1 fetch fails here.
  it("walks to the next page when the channel list exceeds one page", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => channel(index + 1))
    const api = stubApi({ [taskflowTables.agentChannels]: { rows, count: rows.length } })
    const slice = await fetchWorkspaceChannels(7)
    expect(api.for(taskflowTables.agentChannels)).toHaveLength(2)
    expect(searchOf(api.for(taskflowTables.agentChannels)[1]).get("page")).toBe("2")
    expect(slice.agentChannels).toHaveLength(150)
    expect(slice.agentChannels.at(-1)?.id).toBe(150)
  })

  // The items 3 hazard as a request test: the slice must hand back the CHANNELS
  // IT FETCHED. Returning an empty list is the state that makes
  // `mapLiveChannelChats` synthesise a project room.
  it("returns the fetched channels and marks the list as loaded", async () => {
    stubApi({ [taskflowTables.agentChannels]: { rows: [channel(3)], count: 1 } })
    const slice = await fetchWorkspaceChannels(7)
    expect(slice.agentChannels.map((row) => row.id)).toEqual([3])
    expect(slice.agentChannelsLoaded).toBe(true)
    // A loader ANSWERING is the only thing that clears a recorded failure —
    // the flag's other half, and the reason it can be read as "the last
    // completed read".
    expect(slice.agentChannelsFailed).toBe(false)
  })

  it("keeps only the members of the channels it fetched", async () => {
    stubApi({
      [taskflowTables.agentChannels]: { rows: [channel(1)], count: 1 },
      [taskflowTables.agentChannelMembers]: {
        rows: [
          { id: 5, channel: 1, member_kind: "user", display_name: "dalmas" },
          { id: 6, channel: 99, member_kind: "user", display_name: "someone else" },
        ],
        count: 2,
      },
    })
    const slice = await fetchWorkspaceChannels(7)
    expect(slice.agentChannelMembers.map((row) => row.id)).toEqual([5])
  })
})

describe("fetchWorkspaceChat", () => {
  // The third loader that sets `agentChannelsLoaded`, and the only one that set
  // it with nothing asserting it: this is the slice the chat DOCK loads on
  // every route that is not the design page. Mutating it to `false` used to
  // leave every test green — and the fallthrough that repairs a missing channel
  // list (`chatChannelsNeeded && !slices.channels && !slices.chat`, App.tsx)
  // only fires on `/dashboard/design`, so the state it produces elsewhere is
  // the one the dock's error affordance exists for: an unknown list that
  // nothing is coming to fix.
  //
  // Same two assertions as the channels-only loader above, deliberately.
  it("returns the fetched channels and marks the list as loaded", async () => {
    stubApi({ [taskflowTables.agentChannels]: { rows: [channel(3)], count: 1 } })
    const slice = await fetchWorkspaceChat(7)
    expect(slice.agentChannels.map((row) => row.id)).toEqual([3])
    expect(slice.agentChannelsLoaded).toBe(true)
    expect(slice.agentChannelsFailed).toBe(false)
  })
})

describe("fetchTaskflowWorkspace", () => {
  // The core workspace has NOT asked about channels, so its empty list is
  // UNKNOWN rather than "this project has none" — the distinction the surfaces
  // that select a conversation depend on.
  it("starts the channel list unknown, not empty", async () => {
    stubApi({ [taskflowTables.projects]: { rows: [{ id: 7, name: "Board" }], count: 1 } })
    const workspace = await fetchTaskflowWorkspace(7)
    expect(workspace.agentChannels).toEqual([])
    expect(workspace.agentChannelsLoaded).toBe(false)
  })
})

describe("fetchTaskTitles", () => {
  it("asks for exactly the ids, and only the columns it reads", async () => {
    const api = stubApi({ [taskflowTables.tasks]: { rows: [{ id: 3, title: "Fix it" }], count: 1 } })
    const titles = await fetchTaskTitles([3])
    expect(titles).toEqual([{ id: 3, title: "Fix it" }])
    const [entry] = api.for(taskflowTables.tasks)
    const params = searchOf(entry)
    expect(params.get("id__in")).toBe("3")
    expect(params.get("fields")).toBe("id,title")
    // Without the ceiling the request would come back with 25 rows, and without
    // `fields` it would come back with the description and notes this exists to
    // avoid — `description_markdown` is the fattest column in the app.
    expect(params.get("page_size")).toBe("100")
  })

  it("de-duplicates ids and makes no request at all for none", async () => {
    const api = stubApi({ [taskflowTables.tasks]: { rows: [{ id: 3, title: "Fix it" }], count: 1 } })
    await fetchTaskTitles([])
    expect(api.for(taskflowTables.tasks)).toHaveLength(0)
    await fetchTaskTitles([3, 3, 3])
    expect(searchOf(api.for(taskflowTables.tasks)[0]).get("id__in")).toBe("3")
  })

  it("chunks more ids than one page", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, title: `t${index + 1}` }))
    const api = stubApi({ [taskflowTables.tasks]: { rows, count: rows.length } })
    const titles = await fetchTaskTitles(rows.map((row) => row.id))
    const requests = api.for(taskflowTables.tasks)
    expect(requests).toHaveLength(2)
    expect(searchOf(requests[0]).get("id__in")?.split(",")).toHaveLength(100)
    expect(searchOf(requests[1]).get("id__in")?.split(",")).toHaveLength(50)
    expect(titles).toHaveLength(150)
  })
})

describe("fetchTaskflowProjectSummary", () => {
  // Two counts per project, and each of them used to return a whole task row —
  // description and notes included — to read one number out of the envelope.
  it("counts with a sparse fieldset rather than a whole task row", async () => {
    const api = stubApi({
      [taskflowTables.projects]: { rows: [{ id: 7, name: "Board" }], count: 1 },
      [taskflowTables.tasks]: { rows: [{ id: 11 }], count: 4 },
    })
    const summary = await fetchTaskflowProjectSummary()
    const countRequests = api.for(taskflowTables.tasks)
    expect(countRequests).toHaveLength(2)
    for (const entry of countRequests) {
      const params = searchOf(entry)
      expect(params.get("fields")).toBe("id")
      expect(params.get("page_size")).toBe("1")
    }
    // The numbers come from the envelope, which `fields` does not touch.
    expect(summary.taskCounts).toEqual({ 7: 4 })
    expect(summary.reviewCounts).toEqual({ 7: 4 })
  })
})


describe("fetchChannelMessages", () => {
  it("asks for one channel's messages with no message-flag narrowing", async () => {
    // The design conversation is a ROOM now, so the channel is the whole filter.
    // The `is_design = true` clause this used to take on request would drop rows
    // that ARE in the design room while their own mirror flag disagrees — rows
    // written before the flag became derived from the destination. The option is
    // deleted rather than left unused, and tsc pins the shape; this pins the
    // REQUEST, which is what reaches the server and what a future re-add changes.
    const api = stubApi({ [taskflowTables.agentMessages]: { rows: [{ id: 5, channel: 17 }], count: 1 } })
    await fetchChannelMessages(17, 2)

    const requests = api.for(taskflowTables.agentMessages)
    expect(requests).toHaveLength(1)
    const search = searchOf(requests[0])
    expect(search.get("channel")).toBe("17")
    expect(search.get("page")).toBe("2")
    expect(search.get("is_design")).toBeNull()
  })
})
