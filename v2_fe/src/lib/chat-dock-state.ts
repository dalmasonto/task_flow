/// #55: remembering which conversation the chat dock was on.
///
/// Deliberately NOT in the URL. The dock exists so you can message someone
/// without navigating away from the board — putting it in the address bar would
/// make it a route again, which is the thing it replaces. localStorage instead,
/// so the conversation survives a reload without touching navigation.
///
/// **The dock's OPEN flag is deliberately not persisted.** It used to be, and
/// the app's chat slice was gated on it: with localStorage saying "open", a
/// user who had ever opened the dock fetched the project's channels, channel
/// members, newest message page, newest attachment page, read cursors and
/// prompts on EVERY dashboard route for the rest of that browser's life —
/// before opening a chat, and whether or not one was on screen. A stored
/// preference is not a statement that a surface is showing now, and only the
/// latter justifies a fetch. The dock opens from the Chat launcher, and that
/// click is what loads its data.

const DOCK_STORAGE_KEY = "taskflow.chatDock"

export type DockState = { chatId: string | null }

/// No conversation stored. The answer for a first visit and for any record we
/// cannot read.
export const NO_DOCK_STATE: DockState = { chatId: null }

/// Read a stored record defensively. Anything unexpected — malformed JSON, a
/// non-object, a half-written record — collapses to `NO_DOCK_STATE` rather than
/// letting `undefined` reach the conversation resolver as if it were an id.
///
/// An `open` key is accepted and ignored: records written before the flag was
/// dropped are still on disk in every browser that used the dock, and reading
/// them must not resurrect the fetch they used to trigger.
export function parseDockState(raw: string | null): DockState {
  if (!raw) return NO_DOCK_STATE
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NO_DOCK_STATE
  }
  if (typeof parsed !== "object" || parsed === null) return NO_DOCK_STATE
  const record = parsed as { chatId?: unknown }
  return { chatId: typeof record.chatId === "string" ? record.chatId : null }
}

function read(): DockState {
  if (typeof window === "undefined") return NO_DOCK_STATE
  return parseDockState(window.localStorage.getItem(DOCK_STORAGE_KEY))
}

export function loadDockChatId(): string | null {
  return read().chatId
}

export function saveDockState(chatId: string | null) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify({ chatId }))
}
