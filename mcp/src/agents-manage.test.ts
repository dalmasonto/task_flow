import { describe, expect, it } from "vitest";
import { TaskflowApiError } from "./client.js";
import { SELF_REVOKE_REFUSAL, SCOPE_REFUSAL, agentsManageFailure } from "./agents-manage.js";

describe("agentsManageFailure", () => {
  it("reads a plain 403 as the missing scope", () => {
    const err = new TaskflowApiError("POST", "/agents/agent/agents", 403, "Forbidden");
    expect(agentsManageFailure(err)).toBe(SCOPE_REFUSAL);
  });

  it("reads the self-revoke code as its own refusal, not the scope one", () => {
    const err = new TaskflowApiError(
      "DELETE",
      "/agents/agent/agents/7",
      403,
      "An agent cannot revoke itself: that would kill the key making this call. Ask your human to delete this agent.",
      "cannot_delete_self",
    );
    expect(agentsManageFailure(err)).toBe(SELF_REVOKE_REFUSAL);
    expect(agentsManageFailure(err)).not.toBe(SCOPE_REFUSAL);
  });

  it("says nothing extra for other failures, so fail() prints the backend detail", () => {
    expect(agentsManageFailure(new TaskflowApiError("DELETE", "/x", 404, "Not Found"))).toBeNull();
    expect(agentsManageFailure(new TaskflowApiError("DELETE", "/x", 500, "boom", "cannot_delete_self"))).toBeNull();
  });
});
