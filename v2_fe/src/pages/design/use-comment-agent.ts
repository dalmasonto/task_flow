import { useState } from "react"

import type { DesignAgent } from "@/lib/design-api"

/// Who comments go to by default: the last agent picked here, else the first.
const AGENT_KEY = "taskflow.design.commentAgent"
export function useCommentAgent(agents: DesignAgent[]): [number | null, (id: number) => void] {
  const [picked, setPicked] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(AGENT_KEY))
      return Number.isFinite(v) && v > 0 ? v : null
    } catch {
      return null
    }
  })
  const valid = picked != null && agents.some((a) => a.id === picked) ? picked : (agents[0]?.id ?? null)
  const set = (id: number) => {
    setPicked(id)
    try {
      localStorage.setItem(AGENT_KEY, String(id))
    } catch {
      // Private window: remembered for this visit only.
    }
  }
  return [valid, set]
}

