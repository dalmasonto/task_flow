import { describe, it, expect } from "vitest"
import { issueRefFromUrl, githubConnectUrl } from "./taskflow-api"

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
