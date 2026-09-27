/// The export's webfonts. A page captures itself as an SVG image, and an image
/// loads nothing, so every font it uses has to travel INLINE, as a data: URL.
/// The page cannot fetch them itself — its sandbox's `connect-src` is kept
/// tight on purpose (`composer.rs`, `sandbox_csp`) — so it tells the chrome
/// where its fonts come from (`design:font-sources`) and this module fetches
/// them here, outside the sandbox, and answers with self-contained CSS.
///
/// What it will fetch is bounded: https only, never a local or private host,
/// no credentials, a GET, and only as much as a font set plausibly needs. And
/// it can only READ what any page could — a cross-origin response it gets
/// back is one the host already serves with CORS to everyone.

export type FontSources = {
  /// Stylesheets to fetch and read: cross-origin links and @imports.
  sheets: string[]
  /// @font-face rules the page could read itself, their urls made absolute.
  faces: string[]
}

type Fetcher = (url: string) => Promise<Response>

const MAX_SHEETS = 20
const MAX_FONT_FILES = 120
const MAX_FONT_BYTES = 4 * 1024 * 1024

/// Whether this module may fetch `url` on a page's behalf: https, and a public
/// host name — not localhost, an IP literal or a `.local`/`.internal` name,
/// which is how a page could otherwise reach the operator's own network.
export function isFetchableUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return false
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return false
  return host.includes(".")
}

const FACE_RE = /@font-face\s*\{[^}]*\}/g
const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g

/// The @font-face rules in a stylesheet's text, each url made absolute against
/// the stylesheet's own address (Google's CSS uses absolute urls; others use
/// relative ones).
export function fontFacesIn(cssText: string, baseUrl: string): string[] {
  return (cssText.match(FACE_RE) ?? []).map((face) =>
    face.replace(URL_RE, (raw, _q: string, url: string) => {
      if (url.startsWith("data:")) return raw
      try {
        return `url("${new URL(url, baseUrl).href}")`
      } catch {
        return raw
      }
    }),
  )
}

const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" }

/// A font file as a data: url. Its type is the response's, or else read from
/// the file's extension — some font hosts serve woff2 as octet-stream.
async function toDataUrl(url: string, blob: Blob): Promise<string> {
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? ""
  const type = blob.type && blob.type !== "application/octet-stream" ? blob.type : (FONT_TYPES[ext] ?? "font/woff2")
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

/// Per-URL caches for the life of the tab: every page of an export (and the
/// next export) shares one font set, so each file is fetched once.
const sheetCache = new Map<string, Promise<string>>()
const fileCache = new Map<string, Promise<string | null>>()

/// Self-contained font CSS for a page: its @font-face rules, from its readable
/// sheets and from the ones fetched here, with every font file inlined. A
/// source that cannot be fetched is skipped — the page still captures, in the
/// fonts it can have.
export async function inlineFontCss(sources: FontSources, fetcher: Fetcher = (u) => fetch(u, { credentials: "omit" })): Promise<string> {
  const sheets = sources.sheets.filter(isFetchableUrl).slice(0, MAX_SHEETS)
  const fetched = await Promise.all(
    sheets.map((url) => {
      let pending = sheetCache.get(url)
      if (!pending) {
        pending = fetcher(url)
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => "")
        sheetCache.set(url, pending)
      }
      return pending.then((text) => fontFacesIn(text, url))
    }),
  )
  const faces = [...sources.faces, ...fetched.flat()]
  if (!faces.length) return ""

  const files = [...new Set(faces.flatMap((face) => [...face.matchAll(URL_RE)].map((m) => m[2])))]
    .filter((url) => !url.startsWith("data:") && isFetchableUrl(url))
    .slice(0, MAX_FONT_FILES)
  const inlined = new Map<string, string>()
  await Promise.all(
    files.map(async (url) => {
      let pending = fileCache.get(url)
      if (!pending) {
        pending = fetcher(url)
          .then(async (res) => {
            if (!res.ok) return null
            const blob = await res.blob()
            return blob.size <= MAX_FONT_BYTES ? toDataUrl(url, blob) : null
          })
          .catch(() => null)
        fileCache.set(url, pending)
      }
      const data = await pending
      if (data) inlined.set(url, data)
    }),
  )

  // A face whose files could not all be inlined is dropped rather than kept
  // with a remote url: the image cannot load one, and a partial face is what
  // makes a capture mix two fonts.
  return faces
    .map((face) => {
      let complete = true
      const out = face.replace(URL_RE, (raw, _q: string, url: string) => {
        if (url.startsWith("data:")) return raw
        const data = inlined.get(url)
        if (!data) complete = false
        return data ? `url("${data}")` : raw
      })
      return complete ? out : null
    })
    .filter((face): face is string => face !== null)
    .join("\n")
}
