import { describe, it, expect, afterEach, vi } from "vitest"
import { downloadPageHtml, fetchPageHtmlFragment } from "./design-api"

// The test environment is plain node (see vite.config.ts), not jsdom, so
// `downloadPageHtml`'s Blob-and-`<a download>` dance needs a minimal stand-in
// for `document`/`URL` rather than a real DOM.
function stubDom() {
  const link = { href: "", download: "", click: vi.fn(), remove: vi.fn() }
  vi.stubGlobal("document", {
    createElement: vi.fn(() => link),
    body: { appendChild: vi.fn() },
  })
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  })
  return link
}

describe("downloadPageHtml", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("requests the default (full document) page.html URL", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    stubDom()

    await downloadPageHtml(7, "/settings")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/design/7/page.html?route=%2Fsettings")
    expect(url).not.toContain("fragment")
  })

  it("encodes the route in the query string and saves via a synthetic link", async () => {
    const fetchMock = vi.fn((_url: string) => Promise.resolve(new Response("ok", { status: 200 })))
    vi.stubGlobal("fetch", fetchMock)
    const link = stubDom()

    await downloadPageHtml(1, "/a b/c")

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/design/1/page.html?route=${encodeURIComponent("/a b/c")}`)
    expect(link.click).toHaveBeenCalledTimes(1)
  })
})

describe("fetchPageHtmlFragment", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("requests fragment=1 and returns the body text", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        new Response("<div>hi</div>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)

    const text = await fetchPageHtmlFragment(7, "/")

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/design/7/page.html?route=%2F&fragment=1")
    expect(text).toBe("<div>hi</div>")
  })

  it("throws when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("nope", { status: 403 })))
    )
    await expect(fetchPageHtmlFragment(7, "/")).rejects.toThrow()
  })
})
