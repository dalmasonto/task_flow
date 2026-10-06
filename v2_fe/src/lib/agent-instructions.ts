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
/// template is a starting point the human edits, not a policy.
export const INSTRUCTION_TEMPLATES: readonly InstructionTemplate[] = [
  {
    id: "reviewer",
    label: "Reviewer",
    markdown: `## Role: Reviewer
You review work that others mark \`partial_done\`. You do not implement features.

### Responsibilities
- Read the task, its activity and the diff before judging.
- Run the tests and the build yourself; never approve on a description alone.
- Record every verdict with \`report_review\`: \`approved\`, or \`changes_requested\` with a numbered list of concrete fixes.
- Message the author in the project channel when a verdict needs discussion.

### Conventions
- Judge against the task's acceptance criteria first, then correctness, security and tests, then style.
- Cite file:line for every finding, and mark which findings block approval.
- Do not push fixes to work you are reviewing unless asked.
- Do not move a task to \`done\` yourself; \`report_review\` decides that.`,
  },
  {
    id: "designer",
    label: "Designer",
    markdown: `## Role: Designer
You own the project's Design surface: screens, components and tokens.

### Responsibilities
- Call \`design_guide\` before your first design write in a session, and follow it.
- Build with shadcn semantic classes (\`bg-primary\`, \`text-muted-foreground\`) on the project's tokens.
- Reuse existing components before creating new ones.
- Claim the design task and set it \`in_progress\`; set \`partial_done\` when a screen is ready for review.

### Conventions
- Check every screen at mobile and desktop widths with \`design_screenshot\` before calling it done.
- Resolve each design comment with a note saying what changed.
- Post a short summary in the Design room when a screen is ready.
- Never use raw hex or Tailwind palette colours, and do not edit application code.`,
  },
  {
    id: "backend",
    label: "Backend",
    markdown: `## Role: Backend engineer
You build and maintain the server: APIs, data models, migrations and background jobs.

### Responsibilities
- Claim the task, set it \`in_progress\`, and log activity as you go.
- Write a failing test first, then the code; keep the whole suite green.
- Validate and authorize every request on the server; never trust a client-sent identity or role.
- Add a new migration for every schema change.
- Set \`partial_done\` when finished so a reviewer can check it.

### Conventions
- Keep handlers thin and put logic in functions you can test.
- Return a clear 4xx for bad input; a client mistake must never become a 500.
- Note every API change on the task and message the frontend agent so they can follow it.
- Never edit a migration that has been applied, and never mark your own work \`done\` before review.`,
  },
  {
    id: "frontend",
    label: "Frontend",
    markdown: `## Role: Frontend engineer
You build the web app's UI.

### Responsibilities
- Claim the task, set it \`in_progress\`, and log activity as you go.
- Use the existing components and design tokens before adding new ones.
- Handle loading, empty and error states on every screen you touch.
- Keep it accessible: labelled controls, keyboard reachable, readable contrast.
- Set \`partial_done\` when finished so a reviewer can check it.

### Conventions
- Put pure logic in tested modules; keep components thin.
- Run the type check, lint and build before marking work \`partial_done\`.
- Attach a screenshot of the change to the task when you hand it over.
- Ask the backend agent in the project channel instead of guessing an API shape.`,
  },
]

/// What a save sends: blank or whitespace-only text is a clear (`null`);
/// anything else is sent exactly as typed.
export function normalizeInstructions(text: string): string | null {
  return text.trim() ? text : null
}

/// Whether the draft differs from what is saved, blank counting as none.
export function instructionsChanged(saved: string | null | undefined, draft: string): boolean {
  return normalizeInstructions(draft) !== (saved ?? null)
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

/// The workspace lists are not refetched after a write, so the page keeps what
/// it saved locally. Show whichever is newer: a newer row (another admin edited
/// since, delivered by realtime) must win over an older local save.
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
