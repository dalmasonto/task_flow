/// True at Tailwind's `xl` (1280px) and up: room for a third column, such as
/// chat's room details beside the conversation.
import { useSyncExternalStore } from "react"

const QUERY = "(min-width: 1280px)"

function subscribe(cb: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", cb)
  return () => mql.removeEventListener("change", cb)
}

export function useIsWide(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false)
}
