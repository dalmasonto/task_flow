/**
 * #605: how a failed agent-management call reads to the agent.
 *
 * A bare "403" is a dead end, and there are TWO different 403s on these routes:
 * the key lacks `agents:manage` (remedy: ask a human for a scoped key) and a
 * self-revoke (remedy: ask a human to delete this agent). They are told apart
 * by the backend's machine code, never by its prose — a sentence can be
 * reworded without anyone noticing this file depended on it.
 */
import type { TaskflowApiError } from "./client.js";

export const SCOPE_REFUSAL =
  "Error: this agent key cannot manage agents — it does not carry the `agents:manage` scope. " +
  "Ask your human to mint one from the dashboard's Connect-agents page (tick " +
  "\"Can manage agents\" while linking), then switch to it. A key minted by an agent never carries a scope.";

export const SELF_REVOKE_REFUSAL =
  "Error: an agent cannot delete itself — that would revoke the key making this call, mid-run, " +
  "with no way back. Ask your human to delete this agent from the Connect-agents page instead.";

/**
 * The message for a `TaskflowApiError` on an agent-management route, or null
 * when this module has nothing more specific to say than `Error: <detail>`.
 */
export function agentsManageFailure(err: TaskflowApiError): string | null {
  if (err.status !== 403) return null;
  if (err.code === "cannot_delete_self") return SELF_REVOKE_REFUSAL;
  return SCOPE_REFUSAL;
}
