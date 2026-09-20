import { describe, expect, it } from "vitest"
import { mapLiveChannelMessages } from "./live-mappers"
import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import type { TaskflowAgentMessage } from "@/api/client"

function workspaceWithMessages(messages: TaskflowWorkspace["agentMessages"]): TaskflowWorkspace {
  return {
    agentMessages: messages,
    channelReadCursors: [],
    messageAttachments: [],
  } as unknown as TaskflowWorkspace
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
