import { describe, it, expect } from "vitest"
import { UmbralError } from "@/api/client"
import {
  isScopeDenial,
  realtimeEventHasInlineRow,
  realtimeTablesWithInlineRows,
  taskflowTables,
} from "./taskflow-api"

describe("isScopeDenial", () => {
  // Chat events now reach every member of the project while the ROWS stay
  // channel-scoped, so a refetch for a DM you are not on is denied by design.
  // Treating that as a sync failure would paint an error banner every time
  // anyone else exchanged a message.
  it("treats a denied refetch as expected, not as a failure", () => {
    expect(isScopeDenial(new UmbralError(404, null))).toBe(true)
    expect(isScopeDenial(new UmbralError(403, null))).toBe(true)
  })

  it("still reports real failures", () => {
    expect(isScopeDenial(new UmbralError(500, null))).toBe(false)
    expect(isScopeDenial(new UmbralError(400, null))).toBe(false)
    expect(isScopeDenial(new TypeError("network down"))).toBe(false)
    expect(isScopeDenial(null)).toBe(false)
  })

  // 401 means the session died — that IS worth surfacing, and silently
  // swallowing it would leave the UI looking connected but frozen.
  it("does not swallow an expired session", () => {
    expect(isScopeDenial(new UmbralError(401, null))).toBe(false)
  })
})

describe("realtimeTablesWithInlineRows", () => {
  // The contract half that lives in TypeScript. Its partner is
  // backend/tests/realtime_dm_privacy.rs, which asserts the wire carries no
  // body. If someone re-adds `.fields(...)` for a chat table on the backend,
  // that test goes red; if someone re-adds a chat table here, this one does.
  it("carries no chat table", () => {
    for (const table of [
      taskflowTables.agentMessages,
      taskflowTables.messageAttachments,
      taskflowTables.agentChannels,
      taskflowTables.agentChannelMembers,
    ]) {
      expect(realtimeEventHasInlineRow(table)).toBe(false)
    }
  })

  // Terminal frames stream at high frequency; a refetch each would be one
  // request per frame, which is the regression 4b12661 fixed.
  it("keeps the high-frequency non-chat tables inline", () => {
    expect(realtimeEventHasInlineRow(taskflowTables.terminalFrames)).toBe(true)
    expect(realtimeEventHasInlineRow(taskflowTables.agentSessions)).toBe(true)
    expect(realtimeTablesWithInlineRows).toHaveLength(4)
  })
})
