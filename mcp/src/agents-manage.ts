/**
 * #605/#700: how a refused agent-key capability reads to the agent.
 *
 * A bare "403" is a dead end, and there are three different refusals behind it:
 * the key lacks a capability (remedy: ask a human to switch it on), the key is
 * restricted for its own protection from deleting itself (remedy: ask a human
 * to delete it), or it lacks `agents:manage` from a backend that predates the
 * capability envelope. They are told apart by the backend's machine code, never
 * by its prose — a sentence can be reworded without anyone noticing this file
 * depended on it.
 */
import type { TaskflowApiError } from "./client.js";

/// The capability a tool needs is a fact about the KEY, so the sentence says
/// where to change it rather than suggesting a retry.
export function capabilityDeniedMessage(capability: string): string {
  return (
    `Error: this agent key does not have the \`${capability}\` capability, so the server refused the call. ` +
    "Capabilities are per key: a project owner/admin can switch this one on (or off) from the dashboard's " +
    "Connect-agents page. Do not retry — either ask your human for the capability, or work around it."
  );
}

export const SELF_REVOKE_REFUSAL =
  "Error: an agent cannot delete itself — that would revoke the key making this call, mid-run, " +
  "with no way back. Ask your human to delete this agent from the Connect-agents page instead.";

/// A 403 on an agent-management route with no code of its own: the key lacks
/// `agents:manage`, and the backend that said so predates #700's envelope.
export const SCOPE_REFUSAL = capabilityDeniedMessage("agents:manage");

/**
 * The message for a failed call, or null when this module has nothing more
 * specific to say than `Error: <detail>`. Used by EVERY tool's error path, so a
 * denied design write and a denied agent mint read the same way.
 */
export function capabilityFailure(err: TaskflowApiError): string | null {
  if (err.status !== 403) return null;
  if (err.code === "cannot_delete_self") return SELF_REVOKE_REFUSAL;
  if (err.code === "capability_denied" && err.capability) return capabilityDeniedMessage(err.capability);
  return null;
}

/**
 * The agent-management variant: the same rules, plus the pre-#700 fallback,
 * because only these routes ever answered a bare 403 for a missing capability.
 */
export function agentsManageFailure(err: TaskflowApiError): string | null {
  return capabilityFailure(err) ?? (err.status === 403 ? SCOPE_REFUSAL : null);
}
