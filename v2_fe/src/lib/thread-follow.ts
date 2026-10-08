/// #661: when a chat thread should follow new messages to the bottom.
///
/// The thread used to jump to the bottom whenever the message COUNT changed,
/// which yanked a reader who had scrolled up, both on a realtime arrival and on
/// fetching older history (a prepend changes the count too). These helpers look
/// at the TAIL instead: only messages appended after the last one the thread
/// had are "new".

/// Distance from the bottom, in px, still treated as "at the bottom": a reader
/// a few pixels off (rounding, a late-loading image) is still following.
export const AT_BOTTOM_SLACK_PX = 80

export const isAtBottom = (el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX

export type TailChange = {
  /// Messages appended after `prevLastId` (0 for none, a prepend, or a first load).
  appended: number
  /// One of them is the current user's own (`from === "user"`).
  ownAppended: boolean
}

/// What changed at the end of the thread since its last message was
/// `prevLastId`. A `prevLastId` no longer in the list means the last message was
/// swapped in place, which is an optimistic bubble acknowledged under its server
/// id, so it counts as one appended message.
export function tailChange(prevLastId: string | null, messages: readonly { id: string; from: string }[]): TailChange {
  const last = messages[messages.length - 1]
  if (prevLastId == null || !last || last.id === prevLastId) return { appended: 0, ownAppended: false }
  const index = messages.findIndex((m) => m.id === prevLastId)
  const added = index === -1 ? [last] : messages.slice(index + 1)
  return { appended: added.length, ownAppended: added.some((m) => m.from === "user") }
}
