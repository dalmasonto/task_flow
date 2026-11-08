/// #5988: who is writing in each room right now (minus me), re-rendering as
/// events arrive and as each one's time runs out.
import { useEffect, useState } from "react"

import { subscribeTyping, typersNow, type Typer } from "@/lib/typing"

export function useTypers(me: string | null): Map<number, Typer[]> {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribeTyping(() => setNow(Date.now())), [])
  const { byRoom, nextExpiry } = typersNow(now, me)
  useEffect(() => {
    if (nextExpiry == null) return
    const t = setTimeout(() => setNow(Date.now()), Math.max(50, nextExpiry - Date.now() + 20))
    return () => clearTimeout(t)
  }, [nextExpiry])
  return byRoom
}
