import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ChatDock } from "./chat-dock"
import type { TaskflowWorkspace } from "@/lib/taskflow-api"
import type { Project } from "@/lib/workspace-view"

// What the dock DRAWS while it has no conversation to draw — the half the
// loader tests cannot reach (`taskflow-api.test.ts` pins which loaders mark the
// channel list loaded; this pins what the dock does with that fact).
//
// Rendered with `renderToStaticMarkup` — no jsdom, no Testing Library, no new
// dependency. Scope is the markup ONLY: nothing here clicks, so the retry
// button's `onClick` is verified by reading the dock, not by this file. Saying
// so because a markup test mistaken for an interaction test is worse than none.
//
// The loaded dock is deliberately NOT rendered here: its body is
// `AgentsConversationView`, which needs a Router and is not what this file is
// about. Which body it WOULD have is decided by `dockBodyFor`, pinned in
// `lib/chat-dock-state.test.ts`.
//
// Every dock below is handed a workspace whose channel list is EMPTY, because
// that is the state `mapLiveChannelChats` INVENTS a project room in: the
// synthesis is what the negative assertions are looking for.

const project = { id: "1", name: "Board" } as unknown as Project

/// Cast rather than spelled out column by column, the way `live-mappers.test.ts`
/// does it: these tests are about which BODY the dock draws, not about a row.
function workspace({ loaded, failed }: { loaded: boolean; failed?: boolean }): TaskflowWorkspace {
  return {
    project: { id: 1, name: "Board" },
    members: [],
    agents: [],
    agentChannels: [],
    agentChannelMembers: [],
    agentChannelsLoaded: loaded,
    agentChannelsFailed: failed ?? false,
    agentMessages: [],
    messageAttachments: [],
    channelReadCursors: [],
    agentPrompts: [],
    terminalFrames: [],
    agentSessions: [],
  } as unknown as TaskflowWorkspace
}

function dock(ws: TaskflowWorkspace) {
  return renderToStaticMarkup(
    createElement(ChatDock, {
      project,
      liveWorkspace: ws,
      currentUser: null,
      onWorkspaceUpdate: () => {},
      onRefreshWorkspace: async () => {},
      chatId: null,
      onChangeChat: () => {},
      onClose: () => {},
      onComposeTask: () => {},
    })
  )
}

describe("ChatDock while the channel list is not a real answer", () => {
  // The gate. `mapLiveChannelChats` invents a project room when it has no
  // channels, so a dock that draws a conversation — or the switcher that lists
  // one — before the list lands is drawing a room the project does not have,
  // and one click on it PERSISTS that id over the conversation the dock
  // remembered (the bug the gate was added for).
  //
  // What has to change to fail: drawing the body from an unloaded list, which
  // is what this dock did before the gate existed.
  it("draws no conversation until the list is the server's answer", () => {
    const markup = dock(workspace({ loaded: false }))
    expect(markup).toContain("Loading conversations…")
    expect(markup).not.toContain("Project room")
    expect(markup).not.toContain("Switch conversation")
    expect(markup).not.toContain("<textarea")
  })

  // A request that never ANSWERS rejects nothing, so there is no failure to
  // report and no automatic end to the spinner. The escape has to be on the
  // card itself, not implied by it.
  it("offers a way out of the unknown state rather than only a spinner", () => {
    expect(dock(workspace({ loaded: false }))).toMatch(/<button[^>]*>Try again<\/button>/)
  })

  // The failure half, and why it is not merely a nicer spinner: after the slice
  // retry budget is spent nothing re-asks (App.tsx's `MAX_SLICE_RETRIES`), so a
  // dock that cannot tell "not asked yet" from "asked and failed" spins for the
  // rest of the session and cannot say why.
  //
  // What has to change to fail: reading the failure from `agentChannelsLoaded`
  // alone — the flag both states share.
  it("says the read failed when the workspace reports one", () => {
    const markup = dock(workspace({ loaded: false, failed: true }))
    // `renderToStaticMarkup` escapes the apostrophe; that is a detail of the
    // assertion, not of the text on screen.
    expect(markup).toContain("Couldn&#x27;t load conversations")
    expect(markup).toMatch(/<button[^>]*>Try again<\/button>/)
    expect(markup).not.toContain("Loading conversations…")
    expect(markup).not.toContain("Project room")
  })
})
