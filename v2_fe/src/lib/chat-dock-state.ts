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


/// What the dock's BODY is, decided in one place from the four facts that
/// decide it.
///
/// Here rather than in `chat-dock.tsx` for the same reason the record above is:
/// this is the dock's state, and a component file that exports a plain function
/// is not a component file any more (`react-refresh/only-export-components`).
///
/// The ORDER is the behaviour, and it is not obvious: the two unknown-channels
/// states have to outrank the switcher and the conversation, and `minimised`
/// has to outrank them all. Written inline as nested ternaries this was got
/// wrong in both directions — the loading card was drawn OVER a dock the user
/// had already collapsed, and before the gate existed the body was drawn from a
/// SYNTHESISED project room, which is a row the project does not have.
export type DockBody = "collapsed" | "loading" | "failed" | "switcher" | "conversation"

export function dockBodyFor(input: {
  minimised: boolean
  /// Whether the channel list is the server's answer yet.
  channelsLoaded: boolean
  /// Whether the last COMPLETED read of it failed. Callers pass this suppressed
  /// while a manual retry is in flight: the failure is still the last completed
  /// attempt, but a new one is now running, so the body belongs back on the
  /// honest spinner rather than on the error the user just acted on.
  channelsFailed: boolean
  switcherOpen: boolean
}): DockBody {
  // Collapsed wins over everything: a dock the user collapsed stays collapsed,
  // whatever the channel list is doing.
  if (input.minimised) return "collapsed"
  // FAIL-CLOSED. With the list unknown, `mapLiveChannelChats` has no channels
  // to draw and invents one — so every other body here would be built from a
  // room that does not exist. That includes the switcher, whose single row
  // would be that room and whose click PERSISTS the choice, displacing the
  // conversation the dock was remembering. The two states below are the only
  // honest ones, and they are distinguished rather than merged: a spinner for a
  // read that has not completed, an error for one that failed.
  if (!input.channelsLoaded) return input.channelsFailed ? "failed" : "loading"
  return input.switcherOpen ? "switcher" : "conversation"
}
