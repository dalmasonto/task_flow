import { describe, expect, it } from "vitest";
import { TaskflowApiError } from "./client.js";
import {
  SCOPE_REFUSAL,
  SELF_REVOKE_REFUSAL,
  agentsManageFailure,
  capabilityDeniedMessage,
  capabilityFailure,
} from "./agents-manage.js";

const err = (status: number, detail: string, code?: string, capability?: string) =>
  new TaskflowApiError("POST", "/x", status, detail, code, capability);

describe("capabilityFailure", () => {
  it("names the capability the refusal is about", () => {
    const message = capabilityFailure(
      err(403, "This agent key does not have the `design:write` capability.", "capability_denied", "design:write"),
    );
    expect(message).toBe(capabilityDeniedMessage("design:write"));
    expect(message).toContain("design:write");
    expect(message).toContain("Connect-agents");
    expect(message).toContain("Do not retry");
  });

  it("reads the self-revoke code as its own refusal", () => {
    const message = capabilityFailure(err(403, "…", "cannot_delete_self"));
    expect(message).toBe(SELF_REVOKE_REFUSAL);
    expect(message).not.toBe(capabilityDeniedMessage("agents:manage"));
  });

  it("says nothing extra when the body has no code — a reworded sentence cannot break this", () => {
    expect(capabilityFailure(err(403, "Forbidden"))).toBeNull();
    expect(capabilityFailure(err(403, "anything at all", "capability_denied"))).toBeNull();
    expect(capabilityFailure(err(404, "Not Found", "capability_denied", "tasks:write"))).toBeNull();
  });
});

describe("agentsManageFailure", () => {
  it("keeps the pre-#700 fallback: a bare 403 on these routes means no agents:manage", () => {
    expect(agentsManageFailure(err(403, "Forbidden"))).toBe(SCOPE_REFUSAL);
    expect(SCOPE_REFUSAL).toContain("agents:manage");
  });

  it("prefers the specific refusal when the body carries one", () => {
    expect(agentsManageFailure(err(403, "…", "cannot_delete_self"))).toBe(SELF_REVOKE_REFUSAL);
    expect(
      agentsManageFailure(err(403, "…", "capability_denied", "agents:manage")),
    ).toBe(capabilityDeniedMessage("agents:manage"));
  });

  it("leaves other failures to the default error path", () => {
    expect(agentsManageFailure(err(404, "Not Found"))).toBeNull();
    expect(agentsManageFailure(err(500, "boom", "cannot_delete_self"))).toBeNull();
  });
});
