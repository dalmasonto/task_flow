/// Attachment classification + formatting helpers shared by the chat message
/// renderer (`src/components/message-attachments.tsx`) and `src/App.tsx`.

export type AttachmentKind =
  | "image"
  | "pdf"
  | "spreadsheet"
  | "markdown"
  | "video"
  | "audio"
  | "code"
  | "text"
  | "file"

/// Don't fetch/inline text or code bigger than this — fall back to a download
/// card so a huge log file never blocks the thread.
export const INLINE_TEXT_MAX_BYTES = 512 * 1024

const imageExtensions = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
])
const spreadsheetExtensions = new Set(["csv", "ods", "xls", "xlsx"])
const videoExtensions = new Set(["m4v", "mkv", "mov", "mp4", "webm"])
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"])
const textExtensions = new Set([
  "csv",
  "env",
  "gitignore",
  "log",
  "text",
  "txt",
])

/// Extension (or bare filename for extensionless files like `Dockerfile`) →
/// Shiki language id. Returns null for anything not in the curated set.
export function getCodeLanguage(name: string): string | null {
  const lower = name.toLowerCase()
  const base = lower.split("/").pop() ?? lower

  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "docker"
  if (base === "makefile" || base === "gnumakefile") return "make"

  const extension = getFileExtension(name)
  if (!extension) return null

  return codeLanguageByExtension[extension] ?? null
}

const codeLanguageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  rs: "rust",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  dockerfile: "docker",
  makefile: "make",
  lua: "lua",
  r: "r",
  dart: "dart",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
}

/// Classify an attachment for rendering. Uses mime + filename together so a
/// source file uploaded with an unreliable/absent mime (or the classic
/// `.ts` → `video/mp2t` footgun) still resolves to code by extension.
export function getAttachmentKind(contentType: string, name: string): AttachmentKind {
  const mime = (contentType ?? "").toLowerCase()
  const extension = getFileExtension(name)

  if (mime.startsWith("image/") || imageExtensions.has(extension)) return "image"
  if (mime === "application/pdf" || extension === "pdf") return "pdf"

  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    spreadsheetExtensions.has(extension)
  ) {
    return "spreadsheet"
  }

  // Markdown gets its own kind (before code) so the popup can offer a rendered
  // preview + raw toggle rather than only syntax-highlighting the source.
  if (extension === "md" || extension === "markdown") return "markdown"

  // Extension-driven code detection runs before the generic mime buckets so an
  // ambiguous/wrong mime on a source file doesn't misroute it.
  if (getCodeLanguage(name)) return "code"

  if (mime.startsWith("video/") || videoExtensions.has(extension)) return "video"
  if (mime.startsWith("audio/") || audioExtensions.has(extension)) return "audio"

  if (mime.startsWith("text/") || textExtensions.has(extension)) return "text"

  return "file"
}

export function getFileExtension(name: string): string {
  const lastPart = name.split(".").pop()
  return lastPart && lastPart !== name ? lastPart.toLowerCase() : ""
}

export function removeFileExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "")
}

/// Human-readable byte size, e.g. 512 B, 24.0 KB, 3.1 MB.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`
}
