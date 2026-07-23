/**
 * Reading a Claude Code permission prompt off the agent's terminal (#48).
 *
 * `AskUserQuestion` arrives as a hook payload with its options attached, so it
 * reaches the dashboard intact. A *tool approval* does not: the Notification
 * hook fires with nothing but a message string — the shapes actually observed in
 * `taskflow_task_activity` are exactly "Claude needs your permission" and
 * "Claude is waiting for your input", with no tool name and no options. So the
 * options have to be read off the screen.
 *
 * SAFETY. The numbers here are typed into a live terminal. The option list is
 * NOT fixed — a simple prompt offers two, a Bash prompt offers three:
 *
 *     1. Yes
 *     2. Yes, and don't ask again for: gh issue *
 *     3. No
 *
 * Assuming a generic yes/no and sending "2" for No would pick "don't ask again"
 * on a command the human just denied. Everything here therefore REFUSES on
 * anything it does not fully recognise: a null result makes the caller surface a
 * read-only notice instead, and no keystroke is ever sent. An agent left waiting
 * is recoverable; a wrongly-approved command is not.
 *
 * Deliberately dependency-free (like metadata.mjs) so the hook needs no build.
 */

/** The anchor line Claude Code renders above the choices. */
const PROCEED = "Do you want to proceed?";

/** `1. Yes`, optionally preceded by the selection caret (`>` or `❯`). */
const OPTION_LINE = /^\s*[>❯]?\s*(\d+)\.\s+(.*\S)\s*$/;

/** How much of the screen above the anchor to keep as context. */
const MAX_CONTEXT_LINES = 14;
const MAX_QUESTION_CHARS = 2000;

/**
 * Whether a Notification message means "blocked waiting for permission" rather
 * than the idle "waiting for your input" nudge, which is not a question and must
 * not raise one.
 *
 * @param {string | undefined | null} message
 * @returns {boolean}
 */
export function isPermissionNotification(message) {
  if (!message) return false;
  return /needs your permission/i.test(message);
}

/**
 * The permission prompt currently on screen, or null if the screen is not one we
 * recognise with certainty.
 *
 * @param {string} pane raw `tmux capture-pane -p` output
 * @returns {{ question: string, options: { number: number, label: string }[] } | null}
 */
export function parsePermissionPrompt(pane) {
  if (!pane) return null;
  const lines = pane.split("\n");

  // The LAST anchor: scrollback can hold earlier, already-resolved prompts, and
  // their numbering may differ from the live one.
  const anchor = lines.map((line) => line.includes(PROCEED)).lastIndexOf(true);
  if (anchor === -1) return null;

  const options = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      // Blank lines before the list are padding; after it, the list is over.
      if (options.length) break;
      continue;
    }
    const match = OPTION_LINE.exec(line);
    // Any non-option line ends the list — this is what keeps the footer
    // ("Esc to cancel · Tab to amend") out of the options.
    if (!match) break;
    options.push({ number: Number(match[1]), label: match[2] });
  }

  // Contiguous and 1-based, or we do not understand the screen. A gap means we
  // misread a line, and a misread list is one that types the wrong digit.
  if (options.length < 2) return null;
  if (options.some((option, index) => option.number !== index + 1)) return null;

  const context = lines
    .slice(Math.max(0, anchor - MAX_CONTEXT_LINES), anchor)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  const question = (context ? `${context}\n\n${PROCEED}` : PROCEED).slice(-MAX_QUESTION_CHARS);
  return { question, options };
}
