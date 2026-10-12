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
  /** #700: the default-on capabilities this key may NOT use. */
  denied_scopes?: string[];
  /** #700: everything this key may do, defaults included. */
  capabilities?: string[];
};

/** The one line typed into the pane when the instructions changed. */
export const INSTRUCTIONS_UPDATED_NOTICE =
  "[taskflow] your role/project instructions were updated — call whoami";

/**
 * #605/#700: the readable lines about what THIS KEY may do. Rendered in the
 * same block as the instructions (rather than only inside the JSON) because
 * they change what the agent should DO — set up the team itself, or plan around
 * a capability it does not have instead of discovering that with a 403.
 *
 * A RESTRICTED key is told first: an agent that assumes it can write and is
 * refused mid-task has wasted the work.
 */
export function renderScopeNotice(identity: InstructionsCarrier): string | null {
  const denied = identity.denied_scopes ?? [];
  const parts: string[] = [];

  if (denied.length) {
    parts.push(
      "## Your key is restricted — plan around it\n\n" +
        `A project owner/admin switched OFF: ${denied.map((cap) => `\`${cap}\``).join(", ")}. ` +
        "Calls that need those are refused with `capability_denied` (not a transient error — do not retry). " +
        "Reading is never restricted. If the work needs one of them, tell your human which capability is missing " +
        "rather than working around it silently."
    );
  }
  if (identity.scopes?.includes("agents:manage")) {
    parts.push(
      "## Your key can manage agents (agents:manage)\n\n" +
        "You may mint agents in this project (`create_agent`), set their role instructions " +
        "(`set_agent_instructions`) and revoke them (`delete_agent`). Keys you mint are ordinary " +
        "keys — they cannot do this themselves, because only a human owner/admin grants this scope. " +
        "Use it to finish the project's agent setup yourself rather than asking your human to link each agent."
    );
  }
  return parts.length ? parts.join("\n\n") : null;
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
