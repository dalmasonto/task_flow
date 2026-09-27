import { describe, expect, it } from "vitest"
import { fontFacesIn, inlineFontCss, isFetchableUrl } from "./font-inline"

describe("isFetchableUrl", () => {
  it("fetches public https hosts only", () => {
    expect(isFetchableUrl("https://fonts.gstatic.com/s/inter/v1/a.woff2")).toBe(true)
    expect(isFetchableUrl("http://fonts.gstatic.com/a.woff2")).toBe(false)
    expect(isFetchableUrl("https://localhost/a.woff2")).toBe(false)
    expect(isFetchableUrl("https://127.0.0.1/a.woff2")).toBe(false)
    expect(isFetchableUrl("https://[::1]/a.woff2")).toBe(false)
    expect(isFetchableUrl("https://printer.local/a")).toBe(false)
    expect(isFetchableUrl("https://intranet/a")).toBe(false)
    expect(isFetchableUrl("not a url")).toBe(false)
  })
})

describe("fontFacesIn", () => {
  it("keeps only @font-face rules, with urls made absolute", () => {
    const css = `body{color:red}
@font-face { font-family: 'X'; src: url(fonts/x.woff2) format('woff2'); }
@font-face { font-family: 'Y'; src: url("https://cdn.example.com/y.woff2"); }`
    const faces = fontFacesIn(css, "https://cdn.example.com/css/fonts.css")
    expect(faces).toHaveLength(2)
    expect(faces[0]).toContain('url("https://cdn.example.com/css/fonts/x.woff2")')
    expect(faces[1]).toContain('url("https://cdn.example.com/y.woff2")')
  })
})

describe("inlineFontCss", () => {
  const fetcher = (bodies: Record<string, string>) => async (url: string) => {
    if (!(url in bodies)) return new Response("", { status: 404 })
    return new Response(bodies[url], { status: 200 })
  }

  it("fetches the sheet and inlines every font file as a data: url", async () => {
    const css = await inlineFontCss(
      { sheets: ["https://fonts.example.com/css?family=A"], faces: [] },
      fetcher({
        "https://fonts.example.com/css?family=A": "@font-face{font-family:'A';src:url(https://files.example.com/a.woff2) format('woff2')}",
        "https://files.example.com/a.woff2": "font-bytes",
      }),
    )
    expect(css).toContain("font-family:'A'")
    expect(css).toContain('url("data:')
    expect(css).not.toContain("files.example.com")
  })

  it("drops a face whose font could not be fetched, rather than half-inlining it", async () => {
    const css = await inlineFontCss(
      { sheets: [], faces: ["@font-face{font-family:'B';src:url(\"https://files.example.com/missing.woff2\")}"] },
      fetcher({}),
    )
    expect(css).toBe("")
  })

  it("never fetches a local address", async () => {
    const seen: string[] = []
    await inlineFontCss({ sheets: ["https://localhost/f.css", "http://x.example.com/f.css"], faces: [] }, async (url) => {
      seen.push(url)
      return new Response("")
    })
    expect(seen).toEqual([])
  })
})
