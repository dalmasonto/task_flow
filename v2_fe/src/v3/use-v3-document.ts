import { useEffect } from "react"

/// While a /v3 route is mounted, <html> carries `v3` so the scoped design tokens
/// (tokens.css) apply, including to portalled dialogs and popovers.
export function useV3Document() {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add("v3")
    return () => root.classList.remove("v3")
  }, [])
}
