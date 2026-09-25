import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { AppSidebar } from "./app-sidebar"
import { SidebarProvider } from "@/components/ui/sidebar"

// The Design nav entry is the ONLY place a design message is announced outside
// the design page: the design room is excluded from `mapLiveChannelChats`, so
// neither the Agents list nor the dock's switcher has a chat row to hang an
// unread badge on, and the design page itself is where the user already is when
// they are not.
//
// So this file pins the half of that wiring that lives in a component: the count
// App hands the sidebar has to reach the Design entry's badge, and nowhere else
// (`lib/live-mappers.test.ts` pins the count). It exists because the wiring's
// only other guard is the prop being required, which `tsc` enforces on the
// CALLER only — a badge deleted here, or attached to the wrong entry, compiles.
//
// Rendered with `renderToStaticMarkup`, the trick `chat-dock.test.ts` uses: no
// jsdom, no Testing Library, no new dependency. Scope is the markup ONLY —
// nothing here clicks, so this says nothing about which route the entry opens.
// `MemoryRouter` and `SidebarProvider` are the two contexts `NavMain`/`Sidebar`
// read; the sidebar's mobile hook has a server snapshot, so nothing touches
// `window`.
function sidebar(designUnread: number): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        SidebarProvider,
        null,
        createElement(AppSidebar, {
          projects: [],
          activeProjectId: "",
          currentUser: null,
          // Every other badge stays 0, so a `>7<` in the markup can only have
          // come from the count under test.
          pendingReviews: 0,
          pendingInvites: 0,
          designUnread,
          myInviteCount: 0,
          onlineAgents: 0,
          onProjectChange: () => {},
          onNewProject: () => {},
          onInviteProject: () => {},
          onArchiveProject: () => {},
          onNavigate: () => {},
          onLogout: () => {},
        })
      )
    )
  )
}

/// The markup of ONE nav entry: from its own link to the next entry's. A badge
/// that landed on a different item — the failure this test is here for — then
/// cannot satisfy the assertion by being somewhere in the markup.
function entry(markup: string, url: string): string {
  const start = markup.indexOf(`href="${url}"`)
  if (start < 0) throw new Error(`no nav entry linking to ${url}`)
  const next = markup.indexOf('href="/dashboard/', start + 1)
  return markup.slice(start, next < 0 ? markup.length : next)
}

describe("the Design nav entry carries the design room's unread count", () => {
  it("shows the count on the Design entry", () => {
    expect(entry(sidebar(7), "/dashboard/design")).toContain(">7<")
  })

  it("shows no badge at zero", () => {
    const markup = sidebar(0)
    expect(entry(markup, "/dashboard/design")).not.toContain(">7<")
    // The entry itself is still there — otherwise the assertion above would pass
    // on a sidebar that stopped rendering nav at all.
    expect(entry(markup, "/dashboard/design")).toContain("Design")
  })

  it("puts it on no other entry", () => {
    const markup = sidebar(7)
    for (const url of ["/dashboard/overview", "/dashboard/media", "/dashboard/board", "/dashboard/agents"]) {
      expect(entry(markup, url), `${url} must not carry the design badge`).not.toContain(">7<")
    }
  })
})
