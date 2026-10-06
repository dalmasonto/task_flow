/// #615/#616: an agent's role instructions and its project's agent
/// instructions, as the dashboard edits them. Pure: everything a component
/// needs to decide, so the components stay thin.

/// One block, as `whoami` returns it and as the PUTs reply.
export type InstructionsBlock = { markdown: string | null; updated_at: string | null }

export type InstructionTemplate = {
  id: "reviewer" | "designer" | "backend" | "frontend"
  label: string
  markdown: string
}

/// Starter roles for the "Insert template" buttons. Short on purpose: a
/// template is a starting point the human edits, not a policy. Every one names
/// the same working loop — `check_messages` at the start and after each step,
/// `send_message` to talk, `log_activity` for notable actions, and when to set
/// `blocked` / `paused` — so a new agent coordinates from its first session.
export const INSTRUCTION_TEMPLATES: readonly InstructionTemplate[] = [
  {
    id: "reviewer",
    label: "Reviewer",
    markdown: `## Role: Reviewer
You review work that others mark \`partial_done\`. You do not implement features.

### Responsibilities
- Call \`check_messages\` at session start and after each review.
- Read the task, its activity and the diff; run the tests and build yourself.
- Record every verdict with \`report_review\`: \`approved\`, or \`changes_requested\` with numbered fixes.
- Message the author with \`send_message\` when a verdict needs discussion.
- Use \`log_activity\` for notable findings.

### Conventions
- Cite file:line for every finding, and mark which ones block approval.
- If you are waiting on someone, set the task \`blocked\` and message the human; set \`paused\` when you stop mid-review.
- Do not push fixes to work you review, or move a task to \`done\` yourself.`,
  },
  {
    id: "designer",
    label: "Designer",
    markdown: `## Role: Designer
You own the project's Design surface: screens, components and tokens.

### Responsibilities
- Call \`check_messages\` at session start and after each screen.
- Call \`design_guide\` before your first design write in a session.
- Build with shadcn semantic classes on the project's tokens; reuse components first.
- Claim the task, set it \`in_progress\`, and \`log_activity\` for notable changes.
- Set \`partial_done\` and \`send_message\` a summary to the Design room when a screen is ready.

### Conventions
- Check every screen at mobile and desktop widths with \`design_screenshot\`.
- If you are waiting on someone, set the task \`blocked\` and message the human; set \`paused\` when you stop mid-task.
- Never use raw hex colours, and do not edit application code.`,
  },
  {
    id: "backend",
    label: "Backend",
    markdown: `## Role: Backend engineer
You build the server: APIs, data models, migrations and background jobs.

### Responsibilities
- Call \`check_messages\` at session start and after each step.
- Claim the task, set it \`in_progress\`, and \`log_activity\` for notable actions.
- Write a failing test first, then the code; keep the suite green.
- Validate and authorize every request on the server.
- Set \`partial_done\` when finished so a reviewer can check it.

### Conventions
- Return a clear 4xx for bad input; never a 500.
- Tell the frontend agent about API changes with \`send_message\`.
- If you are waiting on someone, set the task \`blocked\` and message the human; set \`paused\` when you stop mid-task.
- Never edit an applied migration.`,
  },
  {
    id: "frontend",
    label: "Frontend",
    markdown: `## Role: Frontend engineer
You build the web app's UI.

### Responsibilities
- Call \`check_messages\` at session start and after each step.
- Claim the task, set it \`in_progress\`, and \`log_activity\` for notable actions.
- Reuse existing components and tokens; handle loading, empty and error states.
- Keep it accessible: labelled controls, keyboard reachable, readable contrast.
- Set \`partial_done\` when finished so a reviewer can check it.

### Conventions
- Run the type check, lint and build before \`partial_done\`.
- Ask the backend agent with \`send_message\` instead of guessing an API shape.
- If you are waiting on someone, set the task \`blocked\` and message the human; set \`paused\` when you stop mid-task.`,
  },
]

/// What a save sends: blank or whitespace-only text is a clear (`null`);
/// anything else is sent exactly as typed.
export function normalizeInstructions(text: string): string | null {
  return text.trim() ? text : null
}

/// Whether the draft differs from what is saved, blank counting as none on
/// BOTH sides (a blank saved value is the same as no instructions).
export function instructionsChanged(saved: string | null | undefined, draft: string): boolean {
  return normalizeInstructions(draft) !== normalizeInstructions(saved ?? "")
}

/// What a close request (Esc, backdrop click, Cancel) does in the agent
/// instructions dialog: with nothing unsaved it closes at once; with unsaved
/// edits it asks "Discard changes?" first, so a stray Esc never loses typing.
export function closeRequestOutcome(dirty: boolean): "close" | "confirm" {
  return dirty ? "confirm" : "close"
}

/// A template fills an empty editor, or is appended below what is already
/// there, so inserting one never destroys the human's typing.
export function insertTemplate(current: string, template: string): string {
  if (!current.trim()) return template
  return `${current.replace(/\s+$/, "")}\n\n${template}`
}

/// A one-line preview for the agent row's badge tooltip: the first non-empty
/// line with heading/list/quote markers removed, truncated to `max` chars.
export function instructionsSnippet(markdown: string | null | undefined, max = 120): string | null {
  if (!markdown || !markdown.trim()) return null
  const line =
    markdown
      .split("\n")
      .map((raw) => raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "").trim())
      .find((candidate) => candidate.length > 0) ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/// Saves patch the workspace (and realtime carries other admins' edits), but an
/// agent linked from this page is not in the workspace roster yet, so the page
/// also keeps what it saved locally. Show whichever is newer: a newer row
/// (another admin edited since) must win over an older local save.
export function latestInstructions(row: InstructionsBlock, local: InstructionsBlock | undefined): InstructionsBlock {
  if (!local) return row
  if (!row.updated_at) return local
  if (!local.updated_at) return row
  return Date.parse(local.updated_at) >= Date.parse(row.updated_at) ? local : row
}

/// The agent row's two columns as a block.
export function agentInstructionsOf(agent: {
  instructions_markdown?: string | null
  instructions_updated_at?: string | null
}): InstructionsBlock {
  return { markdown: agent.instructions_markdown ?? null, updated_at: agent.instructions_updated_at ?? null }
}

/// Patch one agent's instructions columns from a PUT reply, leaving every other
/// agent (and every other column) untouched. An agent not in the list is a no-op.
export function patchAgentInstructions<
  T extends { id: number; instructions_markdown?: string | null; instructions_updated_at?: string | null },
>(agents: readonly T[], agentId: number, block: InstructionsBlock): T[] {
  return agents.map((agent) =>
    agent.id === agentId
      ? { ...agent, instructions_markdown: block.markdown, instructions_updated_at: block.updated_at }
      : agent
  )
}

/// Patch the project's agent-instructions columns from a PUT reply.
export function patchProjectInstructions<
  P extends { agent_instructions_markdown?: string | null; agent_instructions_updated_at?: string | null },
>(project: P, block: InstructionsBlock): P {
  return { ...project, agent_instructions_markdown: block.markdown, agent_instructions_updated_at: block.updated_at }
}
