import { describe, expect, it, vi } from "vitest"

import { batchGroups, batchKindOf, publishBatchEvent, subscribeBatchEvents } from "./batch-live"

describe("batch realtime groups", () => {
  it("names the groups the backend serves, typing included", () => {
    expect(batchGroups(2)).toEqual(["project:2:message_pins", "project:2:message_reactions", "project:2:project_statuses", "project:2:message_deliveries", "project:2:typing"])
  })
  it("maps a stream channel back to its kind, nothing else", () => {
    expect(batchKindOf("project:2:message_pins")).toBe("pins")
    expect(batchKindOf("project:2:project_statuses")).toBe("statuses")
    expect(batchKindOf("project:2:message_deliveries")).toBe("deliveries")
    expect(batchKindOf("project:2:messages")).toBeNull()
    expect(batchKindOf("project:2:typing")).toBeNull()
  })
  it("notifies only that kind's listeners, and unsubscribes", () => {
    const pins = vi.fn()
    const statuses = vi.fn()
    const off = subscribeBatchEvents("pins", pins)
    subscribeBatchEvents("statuses", statuses)
    publishBatchEvent("pins")
    off()
    publishBatchEvent("pins")
    expect(pins).toHaveBeenCalledTimes(1)
    expect(statuses).not.toHaveBeenCalled()
  })
})
