/// The export's external images. A page captures itself as an SVG image, and
/// an image loads nothing, so every `<img>` and CSS background it shows has to
/// travel INLINE as a data: URL. The page cannot fetch them — its sandbox's
/// `connect-src` is kept tight on purpose (`composer.rs`, `sandbox_csp`) — and
/// neither can this document for a host that serves no CORS headers (a stock
/// video's thumbnail, say). So the page asks the chrome (`design:fetch-image`),
/// this module asks the SERVER (`/api/design/{project}/fetch-asset`), and the
/// server fetches the bytes under its own policy (`remote_fetch.rs`: https,
/// public hosts only, images only, capped) and hands them back.
///
/// A url the server's policy would refuse is not even asked for: the same
/// rule, applied here first, keeps a page full of `http:` links from making a
/// hundred round trips that all end in a 400.

import { fetchDesignAsset } from "@/lib/design-api"
import { isFetchableUrl } from "./font-inline"

type Fetcher = (path: string) => Promise<Response>

/// The proxy route for one image of one project.
export function assetProxyPath(projectId: number, url: string): string {
  return `/api/design/${projectId}/fetch-asset?url=${encodeURIComponent(url)}`
}

async function toDataUrl(blob: Blob, contentType: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${contentType};base64,${btoa(binary)}`
}

/// Per-URL cache for the life of the tab: a feed's avatar shows on twenty
/// screens, and an export asks for it twenty times. A failure is cached too —
/// the answer will not change within one export, and every ask costs a server
/// round trip.
const cache = new Map<string, Promise<string | null>>()

/// For tests: forget every cached answer.
export function resetImageCache() {
  cache.clear()
}

/// The image at `url` as a data: URL, or null when it cannot be had — the
/// capture then draws its placeholder, which is what an unfetchable image was
/// drawn as before this existed.
export function inlineImage(
  projectId: number,
  url: string,
  fetcher: Fetcher = (path) => fetchDesignAsset(path),
): Promise<string | null> {
  if (!isFetchableUrl(url)) return Promise.resolve(null)
  const key = `${projectId} ${url}`
  let pending = cache.get(key)
  if (!pending) {
    pending = fetcher(assetProxyPath(projectId, url))
      .then(async (res) => {
        if (!res.ok) return null
        const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
        if (!type.startsWith("image/")) return null
        return toDataUrl(await res.blob(), type)
      })
      .catch(() => null)
    cache.set(key, pending)
  }
  return pending
}
