/// Agents pages need the chat + terminal slices (sessions, frames), which App
/// loads while a chat surface is mounted.
import { useEffect } from "react"

import { useWorkspace } from "../workspace"

export function useAgentSlices() {
  const { setChatSurfaceMounted } = useWorkspace()
  useEffect(() => {
    setChatSurfaceMounted(true)
    return () => setChatSurfaceMounted(false)
  }, [setChatSurfaceMounted])
}
