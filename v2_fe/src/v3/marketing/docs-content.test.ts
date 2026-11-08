import { describe, expect, it } from "vitest"

import { calloutsToMarkdown, docHeadings, parseFrontmatter, resolveDocLink, searchDocs, slugFromPath, sortDocs, toDoc } from "./docs-content"

describe("parseFrontmatter", () => {
  it("reads the keys and strips the block", () => {
    const { meta, body } = parseFrontmatter("---\ntitle: Getting Started\ndescription: \"Set it up\"\nsidebar_position: 2\n---\n\n## Hi")
    expect(meta).toEqual({ title: "Getting Started", description: "Set it up", sidebar_position: "2" })
    expect(body.trim()).toBe("## Hi")
  })
  it("passes a file without frontmatter through", () => {
    expect(parseFrontmatter("# Plain").body).toBe("# Plain")
  })
})

describe("calloutsToMarkdown", () => {
  it("turns a Callout into a labelled blockquote", () => {
    expect(calloutsToMarkdown('<Callout type="info">\nKeep it local.\n</Callout>')).toBe("> **Note**\n>\n> Keep it local.")
  })
  it("labels warnings", () => {
    expect(calloutsToMarkdown('<Callout type="warning">Careful</Callout>')).toContain("**Warning**")
  })
})

describe("slugs and links", () => {
  it("derives slugs, collapsing index files", () => {
    expect(slugFromPath("../../documentation/docs/v2.0.0/agents/claude.mdx")).toBe("agents/claude")
    expect(slugFromPath("x/docs/v2.0.0/agents/index.mdx")).toBe("agents")
    expect(slugFromPath("x/docs/v2.0.0/self-hosting.mdx")).toBe("self-hosting")
  })
  it("resolves relative links the way the docs site does", () => {
    expect(resolveDocLink("getting-started", "./self-hosting")).toBe("/v3/docs/self-hosting")
    expect(resolveDocLink("agents/claude", "../self-hosting")).toBe("/v3/docs/self-hosting")
    expect(resolveDocLink("agents/claude", "./codex#setup")).toBe("/v3/docs/agents/codex#setup")
    // agents/index.mdx: its links resolve against its own folder.
    expect(resolveDocLink("agents", "./claude", true)).toBe("/v3/docs/agents/claude")
    expect(resolveDocLink("agents", "../getting-started", true)).toBe("/v3/docs/getting-started")
  })
  it("leaves absolute, external and fragment links alone", () => {
    for (const h of ["https://x.dev", "/pricing", "#top", "mailto:a@b.c"]) expect(resolveDocLink("a/b", h)).toBe(h)
  })
})

describe("sorting, search and headings", () => {
  const docs = sortDocs([
    toDoc("d/docs/v2.0.0/self-hosting.mdx", "---\ntitle: Self-hosting\nsidebar_position: 1\n---\nRun your own server with Postgres."),
    toDoc("d/docs/v2.0.0/getting-started.mdx", "---\ntitle: Getting Started\nsidebar_position: 2\n---\nInstall the MCP. tmux helps."),
    toDoc("d/docs/v2.0.0/agents/claude.mdx", "---\ntitle: Claude Code\nsidebar_position: 1\n---\nUse tmux."),
  ])
  it("orders by section, then position", () => {
    expect(docs.map((d) => d.slug)).toEqual(["getting-started", "agents/claude", "self-hosting"])
  })
  it("ranks title hits above body hits and needs every word", () => {
    expect(searchDocs(docs, "tmux").map((d) => d.slug)).toEqual(["getting-started", "agents/claude"])
    expect(searchDocs(docs, "self hosting postgres").map((d) => d.slug)).toEqual(["self-hosting"])
    expect(searchDocs(docs, "")).toEqual([])
  })
  it("lists ## headings outside code fences", () => {
    expect(docHeadings("## Install it\n```\n## not a heading\n```\n## Use `tmux`")).toEqual([
      { id: "install-it", text: "Install it" },
      { id: "use-tmux", text: "Use tmux" },
    ])
  })
})
