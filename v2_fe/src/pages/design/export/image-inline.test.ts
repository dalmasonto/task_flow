import { beforeEach, describe, expect, it, vi } from "vitest"
import { assetProxyPath, inlineImage, resetImageCache } from "./image-inline"

const png = (bytes: number[]) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } })

describe("assetProxyPath", () => {
  it("routes through the project's fetch-asset endpoint with the url encoded", () => {
    expect(assetProxyPath(13, "https://images.unsplash.com/a?w=800&q=60")).toBe(
      "/api/design/13/fetch-asset?url=https%3A%2F%2Fimages.unsplash.com%2Fa%3Fw%3D800%26q%3D60",
    )
  })
})

describe("inlineImage", () => {
  beforeEach(() => resetImageCache())

  it("answers a data url typed as the response was", async () => {
    const fetcher = vi.fn(async () => png([1, 2, 3, 4]))
    const data = await inlineImage(13, "https://images.unsplash.com/a.jpg", fetcher)
    expect(data).toBe("data:image/png;base64,AQIDBA==")
    expect(fetcher).toHaveBeenCalledWith(assetProxyPath(13, "https://images.unsplash.com/a.jpg"))
  })

  it("never asks the server for a url the policy would refuse", async () => {
    const fetcher = vi.fn(async () => png([1]))
    expect(await inlineImage(13, "http://images.unsplash.com/a.jpg", fetcher)).toBeNull()
    expect(await inlineImage(13, "https://localhost/a.jpg", fetcher)).toBeNull()
    expect(await inlineImage(13, "https://10.0.0.1/a.jpg", fetcher)).toBeNull()
    expect(await inlineImage(13, "data:image/png;base64,AAAA", fetcher)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("answers null when the server refuses, when it answers with no image, and when the fetch throws", async () => {
    expect(await inlineImage(13, "https://a.example.com/x.jpg", async () => new Response("no", { status: 502 }))).toBeNull()
    expect(
      await inlineImage(
        13,
        "https://b.example.com/x.jpg",
        async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      ),
    ).toBeNull()
    expect(
      await inlineImage(13, "https://c.example.com/x.jpg", async () => {
        throw new Error("offline")
      }),
    ).toBeNull()
  })

  it("fetches each url once for the life of the tab, failures included", async () => {
    const ok = vi.fn(async () => png([9]))
    await inlineImage(13, "https://a.example.com/x.jpg", ok)
    await inlineImage(13, "https://a.example.com/x.jpg", ok)
    expect(ok).toHaveBeenCalledTimes(1)
    const bad = vi.fn(async () => new Response("no", { status: 400 }))
    await inlineImage(13, "https://b.example.com/x.jpg", bad)
    await inlineImage(13, "https://b.example.com/x.jpg", bad)
    expect(bad).toHaveBeenCalledTimes(1)
  })
})
