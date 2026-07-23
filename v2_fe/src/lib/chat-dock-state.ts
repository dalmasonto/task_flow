/// #55: remembering whether the chat dock was open, and on which conversation.
///
/// Deliberately NOT in the URL. The dock exists so you can message someone
/// without navigating away from the board — putting it in the address bar would
/// make it a route again, which is the thing it replaces. localStorage instead,
/// so it survives a reload without touching navigation.

const DOCK_STORAGE_KEY = "taskflow.chatDock"

export type DockState = { open: boolean; chatId: string | null }

/// Shut, on nothing. The default for a first visit and for any record we cannot
/// read: a dock that springs open over a page the user never asked to chat from
/// is worse than one they have to click.
export const DOCK_CLOSED: DockState = { open: false, chatId: null }

/// Read a stored record defensively. Anything unexpected — malformed JSON, a
/// non-object, a half-written record — collapses to DOCK_CLOSED rather than
/// letting `undefined` reach the conversation resolver as if it were an id.
export function parseDockState(raw: string | null): DockState {
  if (!raw) return DOCK_CLOSED
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DOCK_CLOSED
  }
  if (typeof parsed !== "object" || parsed === null) return DOCK_CLOSED
  const record = parsed as { open?: unknown; chatId?: unknown }
  return {
    open: record.open === true,
    chatId: typeof record.chatId === "string" ? record.chatId : null,
  }
}

function read(): DockState {
  if (typeof window === "undefined") return DOCK_CLOSED
  return parseDockState(window.localStorage.getItem(DOCK_STORAGE_KEY))
}

export function loadDockOpen(): boolean {
  return read().open
}

export function loadDockChatId(): string | null {
  return read().chatId
}

export function saveDockState(open: boolean, chatId: string | null) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ open, chatId }))
}
