/// Turning a chat message into a task.
///
/// Commitments made in conversation — "add access rights to Member X", "we need
/// a staging environment" — go missing because opening a form costs more than
/// the sentence did. This closes that gap: the message IS the task, so capture
/// costs one click.
///
/// The split is on the FIRST LINE, not a character count. People writing meeting
/// points put one per line, so the line break is the real boundary; cutting at a
/// fixed offset lands mid-word and reads like a truncation bug. The character cap
/// is only a fallback for a wall of text with no break in it, and even then it
/// breaks on a word.
///
/// Nothing is dropped either way: whatever the title does not take stays in the
/// body, so turning a message into a task never loses what was said.

export const TASK_TITLE_MAX = 80

export type MessageTask = { title: string; description: string }

export function messageToTask(body: string): MessageTask | null {
  const lines = body.split("\n")
  // Leading blank lines are formatting, not the title.
  const firstIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstIndex === -1) return null

  const firstLine = lines[firstIndex]!.trim()
  const rest = lines
    .slice(firstIndex + 1)
    .join("\n")
    .trim()

  if (firstLine.length <= TASK_TITLE_MAX) {
    return { title: firstLine, description: rest }
  }

  // Long first line: cut at the last word boundary inside the cap, and push the
  // whole line into the body so nothing is lost to the truncation.
  const clipped = firstLine.slice(0, TASK_TITLE_MAX)
  const lastSpace = clipped.lastIndexOf(" ")
  const title = (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()
  return {
    title: `${title}…`,
    description: rest ? `${firstLine}\n\n${rest}` : firstLine,
  }
}
