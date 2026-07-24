import { describe, it, expect, afterEach, vi } from "vitest"
import { issueRefFromUrl, githubConnectUrl } from "./taskflow-api"
import { oauthLoginUrl, fetchOAuthProviders } from "./taskflow-api"

describe("issueRefFromUrl", () => {
  it("renders #N from a github issue url", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets/issues/7")).toBe("#7")
  })
  it("returns null for no url", () => {
    expect(issueRefFromUrl(null)).toBeNull()
  })
  it("returns null when there is no issue segment", () => {
    expect(issueRefFromUrl("https://github.com/acme/widgets")).toBeNull()
  })
})

describe("githubConnectUrl", () => {
  it("targets the backend connect route", () => {
    expect(githubConnectUrl()).toContain("/oauth/github/connect")
  })
  it("passes a next return url when given a path", () => {
    const url = githubConnectUrl("/account/settings?github=connected")
    expect(url).toContain("/oauth/github/connect")
    expect(url).toContain("next=")
  })
})

describe("oauthLoginUrl", () => {
  it("targets the backend login route for the given provider", () => {
    expect(oauthLoginUrl("github")).toContain("/oauth/github/login")
  })
  it("passes an encoded next return url", () => {
    const url = oauthLoginUrl("github")
    expect(url).toContain("next=")
    // returnPath is encoded, so the raw slash is percent-escaped
    expect(url).toContain(encodeURIComponent("/dashboard/board"))
  })
  it("honours a custom returnPath", () => {
    expect(oauthLoginUrl("github", "/dashboard/agents")).toContain(
      encodeURIComponent("/dashboard/agents"),
    )
  })
  it("does not throw when window is absent (SSR/node)", () => {
    // In the node test env `window` is undefined; origin resolves to "".
    expect(() => oauthLoginUrl("google")).not.toThrow()
    expect(oauthLoginUrl("google")).toContain("/oauth/google/login")
  })
})

describe("fetchOAuthProviders", () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubFetch = (impl: () => Promise<Response> | Response) =>
    vi.stubGlobal("fetch", vi.fn(impl))

  it("maps a well-formed providers payload", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ providers: [{ key: "github", label: "GitHub" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    expect(await fetchOAuthProviders()).toEqual([{ key: "github", label: "GitHub" }])
  })

  it("drops malformed entries", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ providers: [{ key: "github", label: "GitHub" }, { key: 5 }, {}] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    expect(await fetchOAuthProviders()).toEqual([{ key: "github", label: "GitHub" }])
  })

  it("returns [] on a non-ok response rather than throwing", async () => {
    stubFetch(() => new Response("nope", { status: 500 }))
    expect(await fetchOAuthProviders()).toEqual([])
  })

  it("returns [] on unparseable JSON", async () => {
    stubFetch(() => new Response("{ not json", { status: 200 }))
    expect(await fetchOAuthProviders()).toEqual([])
  })
})
