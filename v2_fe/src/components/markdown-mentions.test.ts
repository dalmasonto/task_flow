import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { MarkdownRenderer } from "./markdown-renderer"

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownRenderer, { content }))

describe("mention chips (#318 / #506)", () => {
  it("draws an agent mention as a chip that names who it is", () => {
    const html = render("ping [@Builder agent](agent:12) please")
    expect(html).toContain('data-mention="agent:12"')
    expect(html).toContain('title="Agent #12"')
    expect(html).toContain("@Builder agent")
    expect(html).not.toContain("href=")
  })

  it("draws a page mention by its route", () => {
    const html = render("see [@Settings](page:/settings)")
    expect(html).toContain('data-mention="page:/settings"')
    expect(html).toContain("Design page /settings")
  })

  it("still blanks an unsafe ordinary link", () => {
    const html = render("[click](javascript:alert(1))")
    expect(html).not.toContain("javascript:")
  })

  it("leaves a normal link a link", () => {
    expect(render("[docs](https://example.com)")).toContain('href="https://example.com"')
  })
})
