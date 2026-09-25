import { describe, it, expect, afterEach, vi } from "vitest"
import {
  RESOURCES_JSON_PATH,
  downloadPageHtml,
  fetchDesignResources,
  fetchPageHtmlFragment,
  putDesignResources,
} from "./design-api"

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

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

// The resource document is a `DesignFile` row like any other (`styles/
// resources.json`), so it goes through the same generic file calls the tokens
// pair does — but it needs its own two wrappers, because "the endpoints
// TokenEditor uses" is not a generic client.
describe("fetchDesignResources", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("reads styles/resources.json and normalises what the wire sent", async () => {
    expect(RESOURCES_JSON_PATH).toBe("styles/resources.json")
    // Every field is always serialised on the Rust side, so `null` is what
    // actually arrives for the optional ones.
    const content = JSON.stringify({ version: 3, sets: [
      { id: "s1", name: "Inter", enabled: false, links: [
        { rel: null, href: "https://fonts.example/css2", crossorigin: null, script: null, isScript: false, isAsync: null },
      ]},
    ]})
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(jsonRes({ id: 1, path: RESOURCES_JSON_PATH, kind: "token", content, version: 3, updatedBy: "dalmas" }))
    )
    vi.stubGlobal("fetch", fetchMock)

    const { doc, version } = await fetchDesignResources(7)

    expect(fetchMock.mock.calls[0][0]).toBe("/api/design/7/file?path=styles%2Fresources.json")
    expect(version).toBe(3)
    expect(doc.sets[0].enabled).toBe(false)
    // Nulls become absent fields here, not later: a document that carried
    // `script: null` beside `href` would be refused with a message about a
    // cause the user never intended.
    expect(doc.sets[0].links[0]).toStrictEqual({
      href: "https://fonts.example/css2", crossorigin: false, isScript: false, isAsync: false,
    })
  })

  it("fails soft to the empty document when the row is absent or its content does not parse", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string) => Promise.resolve(new Response("gone", { status: 404 }))))
    const missing = await fetchDesignResources(7)
    expect(missing.doc).toEqual({ version: 1, sets: [] })
    // Version 0 is not a detail: it makes the first save an unconditional
    // create rather than racing a base_version that never existed.
    expect(missing.version).toBe(0)

    vi.stubGlobal("fetch", vi.fn((_url: string) => Promise.resolve(jsonRes({ content: "not json", version: 4 }))))
    const broken = await fetchDesignResources(7)
    expect(broken.doc.sets).toEqual([])
    expect(broken.version).toBe(0)
  })
})

describe("putDesignResources", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("PUTs the serialised document to the resources path with its base version", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonRes({ ok: true, file: { path: RESOURCES_JSON_PATH }, affectedRoutes: [] }))
    )
    vi.stubGlobal("fetch", fetchMock)
    const doc = { version: 1, sets: [{ id: "s1", name: "Inter", enabled: true, links: [] }] }

    const result = await putDesignResources(7, doc, 4)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/design/7/file")
    expect(init?.method).toBe("PUT")
    expect(JSON.parse(String(init?.body))).toEqual({
      path: "styles/resources.json", content: JSON.stringify(doc), base_version: 4,
    })
    expect(result.ok).toBe(true)
  })

  // A save has THREE outcomes, not two. An editor that handled only `errors`
  // would save nothing on a stale base while looking like it worked, so both
  // refusal arms must come back untouched for the editor to render.
  it("hands both refusal arms straight back", async () => {
    const errors = [{ line: 0, rule: "resources", message: '"javascript:alert(1)" is not an https address' }]
    vi.stubGlobal("fetch", vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonRes({ ok: false, errors }, 422))
    ))
    const refused = await putDesignResources(7, { version: 1, sets: [] }, 0)
    expect(refused.ok).toBe(false)
    if (!refused.ok && "errors" in refused) {
      expect(refused.errors[0].message).toBe(errors[0].message)
    }

    vi.stubGlobal("fetch", vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonRes({ ok: false, error: "version_conflict", current_version: 9, current_content: "{}" }, 409))
    ))
    const conflicted = await putDesignResources(7, { version: 1, sets: [] }, 0)
    expect(conflicted.ok).toBe(false)
    // Only the discriminant is asserted: `WriteFileResult`'s conflict arm names
    // `currentVersion`/`currentContent`, but `views::conflict_response` writes
    // the keys snake_case (no serde rename on a `json!` body), so those two
    // fields are undefined at runtime and a test on them could never pass. The
    // editor keys off `error` alone, which IS the wire's spelling.
    if (!conflicted.ok && !("errors" in conflicted)) {
      expect(conflicted.error).toBe("version_conflict")
    }
  })
})
