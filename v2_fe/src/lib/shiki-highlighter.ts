/// Lazy, module-level Shiki highlighter singleton. The `shiki` package (large)
/// is dynamically imported so it code-splits out of the main bundle, and one
/// highlighter instance is reused across every `highlightCode` call.

import type { BundledLanguage, Highlighter } from "shiki"

let highlighterPromise: Promise<Highlighter> | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: [],
      })
    )
  }
  return highlighterPromise
}

/// Highlight `code` as `lang`, returning dual-theme HTML (light + dark CSS
/// variables). Unknown languages fall back to plain "text". The requested
/// grammar is loaded lazily the first time it's needed.
export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter()
  let language = lang

  if (!highlighter.getLoadedLanguages().includes(language)) {
    try {
      await highlighter.loadLanguage(language as BundledLanguage)
    } catch {
      language = "text"
    }
  }

  return highlighter.codeToHtml(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  })
}
