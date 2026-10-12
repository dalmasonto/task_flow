/**
 * #615/#616: role instructions (per agent) and project instructions (every
 * agent), as `whoami` returns them.
 *
 * Two jobs: render them so a model can read them (JSON escapes every newline
 * into `\n`), and notice when either changed so a running agent is told to
 * re-read them.
 */
import type { InstructionsBlock } from "./client.js";

export type InstructionsCarrier = {
  instructions?: InstructionsBlock | null;
  project_instructions?: InstructionsBlock | null;
  /** #605: the scopes this key carries. Absent on a backend that predates them. */
  scopes?: string[];
};

/** The one line typed into the pane when the instructions changed. */
export const INSTRUCTIONS_UPDATED_NOTICE =
  "[taskflow] your role/project instructions were updated — call whoami";

/**
 * #605: the readable line for a key that carries `agents:manage`. Rendered in
 * the same block as the instructions (rather than only inside the JSON) because
 * it changes what the agent should DO — set up the team itself instead of
 * asking the human to link every agent.
 */
export function renderScopeNotice(identity: InstructionsCarrier): string | null {
  if (!identity.scopes?.includes("agents:manage")) return null;
  return (
    "## Your key can manage agents (agents:manage)\n\n" +
    "You may mint agents in this project (`create_agent`), set their role instructions " +
    "(`set_agent_instructions`) and revoke them (`delete_agent`). Keys you mint are ordinary " +
    "keys — they cannot do this themselves, because only a human owner/admin grants this scope. " +
    "Use it to finish the project's agent setup yourself rather than asking your human to link each agent."
  );
}

const text = (block: InstructionsBlock | null | undefined): string | null =>
  block?.markdown && block.markdown.trim() ? block.markdown : null;

/**
 * A readable rendering of whichever blocks have text, role first, or null when
 * neither does (nothing set, or a backend that predates them).
 */
export function renderInstructions(identity: InstructionsCarrier): string | null {
  const role = text(identity.instructions);
  const project = text(identity.project_instructions);
  if (!role && !project) return null;
  const parts = [
    "Follow these for the rest of this session. Precedence: your human's direct request first, then your role instructions, then the project instructions, then the generic TaskFlow defaults.",
  ];
  if (role) parts.push(`## Your role instructions\n\n${role}`);
  if (project) parts.push(`## Project instructions (for every agent)\n\n${project}`);
  return parts.join("\n\n");
}

/** What identifies "this version" of both blocks: their two `updated_at`s. */
export function instructionsStamp(identity: InstructionsCarrier): string {
  return `${identity.instructions?.updated_at ?? ""}|${identity.project_instructions?.updated_at ?? ""}`;
}

/**
 * Remembers the last-seen stamp. `observe` returns true only when a PREVIOUS
 * observation exists and differs; the first call is a baseline.
 */
export function createInstructionsWatcher(): { observe(identity: InstructionsCarrier): boolean } {
  let last: string | undefined;
  return {
    observe(identity) {
      const stamp = instructionsStamp(identity);
      const changed = last !== undefined && stamp !== last;
      last = stamp;
      return changed;
    },
  };
}
