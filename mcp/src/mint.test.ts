import { describe, it, expect } from "vitest";
import { addProfile, MintError, parseMintArgs, exportHint, requestMint } from "./mint.js";

const base = {
  server: "http://localhost:8000",
  project: 2,
  default_profile: "main",
  profiles: {
    main: { agent_id: 1, key: "key-main", display_name: "Claude (main)" },
  },
};

describe("addProfile", () => {
  it("adds the new profile alongside the existing ones", () => {
    const out = addProfile(base, "bear", { agent_id: 2, key: "key-bear", display_name: "Claude (bear)" });
    expect(Object.keys(out.profiles).sort()).toEqual(["bear", "main"]);
    expect(out.profiles.bear).toEqual({ agent_id: 2, key: "key-bear", display_name: "Claude (bear)" });
  });

  // The existing profile is the credential the running agent authenticates with.
  // Silently replacing it would lock a working terminal out of its own identity,
  // and the key is unrecoverable — the mint response is the only time it exists.
  it("refuses to overwrite an existing profile", () => {
    expect(() => addProfile(base, "main", { agent_id: 9, key: "key-9" })).toThrow(MintError);
    expect(() => addProfile(base, "main", { agent_id: 9, key: "key-9" })).toThrow(/already exists/);
  });

  it("leaves the original object untouched", () => {
    addProfile(base, "bear", { agent_id: 2, key: "key-bear" });
    expect(Object.keys(base.profiles)).toEqual(["main"]);
  });

  // default_profile decides who an un-flagged terminal authenticates as. Moving
  // it would silently repoint every existing terminal at the new agent.
  it("never changes default_profile", () => {
    const out = addProfile(base, "bear", { agent_id: 2, key: "key-bear" });
    expect(out.default_profile).toBe("main");
  });

  it("preserves server and project", () => {
    const out = addProfile(base, "bear", { agent_id: 2, key: "key-bear" });
    expect(out.server).toBe("http://localhost:8000");
    expect(out.project).toBe(2);
  });

  it("rejects a blank profile name rather than writing an unusable key", () => {
    expect(() => addProfile(base, "   ", { agent_id: 2, key: "k" })).toThrow(/name/i);
  });
});

describe("parseMintArgs", () => {
  it("reads the name and display name", () => {
    const a = parseMintArgs(["--mint", "bear", "--display-name", "Claude (bear)"]);
    expect(a.name).toBe("bear");
    expect(a.displayName).toBe("Claude (bear)");
  });

  it("defaults the display name from the profile name", () => {
    expect(parseMintArgs(["--mint", "bear"]).displayName).toBe("Claude (bear)");
  });

  it("takes a token from the flag", () => {
    expect(parseMintArgs(["--mint", "bear", "--token", "t-123"], {}).token).toBe("t-123");
  });

  it("falls back to the environment", () => {
    expect(parseMintArgs(["--mint", "bear"], { TASKFLOW_USER_TOKEN: "t-env" }).token).toBe("t-env");
  });

  // The flag wins so a one-off mint against another account doesn't silently use
  // whatever happens to be exported in the shell.
  it("prefers the flag over the environment", () => {
    expect(parseMintArgs(["--mint", "bear", "--token", "t-flag"], { TASKFLOW_USER_TOKEN: "t-env" }).token).toBe(
      "t-flag",
    );
  });

  it("reports a missing name instead of minting something unnamed", () => {
    expect(() => parseMintArgs(["--mint"])).toThrow(/name/i);
    expect(() => parseMintArgs(["--mint", "--token", "t"])).toThrow(/name/i);
  });
});

describe("requestMint", () => {
  const args = { name: "bear", displayName: "Claude (bear)", token: "t-1" };
  const okBody = { taskflow_profile: { agent_id: 2, key: "key-bear", display_name: "Claude (bear)" } };

  /** Records the call so the assertions see the REAL request, not a shrug. */
  const recorder = (response: Partial<Response> & { json?: () => Promise<unknown> }) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => okBody,
        ...response,
      } as Response;
    };
    return { calls, impl };
  };

  it("posts to the link endpoint on the configured server", async () => {
    const { calls, impl } = recorder({});
    await requestMint("http://localhost:8000", 2, args, "t-1", impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:8000/api/taskflow/agents/link");
  });

  it("does not double the slash when the server has a trailing one", async () => {
    const { calls, impl } = recorder({});
    await requestMint("http://localhost:8000/", 2, args, "t-1", impl);
    expect(calls[0]?.url).toBe("http://localhost:8000/api/taskflow/agents/link");
  });

  // The whole reason this is a CLI: `link_agent` is RequireAuth-gated and an
  // `Agent <key>` header is refused. Sending the wrong scheme would 401 and the
  // failure would look like a bad token rather than a wrong auth model.
  it("authenticates as a USER with Bearer, never as an agent", async () => {
    const { calls, impl } = recorder({});
    await requestMint("http://localhost:8000", 2, args, "t-1", impl);
    const auth = (calls[0]?.init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer t-1");
    expect(auth).not.toMatch(/^Agent /);
  });

  it("sends the project, display name and profile the server needs", async () => {
    const { calls, impl } = recorder({});
    await requestMint("http://localhost:8000", 2, args, "t-1", impl);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      project: 2,
      display_name: "Claude (bear)",
      profile: "bear",
    });
  });

  it("returns the profile block the server minted", async () => {
    const { impl } = recorder({});
    await expect(requestMint("http://localhost:8000", 2, args, "t-1", impl)).resolves.toEqual(
      okBody.taskflow_profile,
    );
  });

  it("explains a 401 as the wrong KIND of credential", async () => {
    const { impl } = recorder({ ok: false, status: 401 });
    await expect(requestMint("http://localhost:8000", 2, args, "t-1", impl)).rejects.toThrow(/USER token/);
  });

  it("explains a 403 as a membership problem, not a bad token", async () => {
    const { impl } = recorder({ ok: false, status: 403 });
    await expect(requestMint("http://localhost:8000", 2, args, "t-1", impl)).rejects.toThrow(/member of project 2/);
  });

  // The raw key exists in this response and nowhere else — the server keeps only
  // a hash. Writing a keyless profile would look like success and authenticate
  // as nobody.
  it("refuses a response with no key rather than writing an unusable profile", async () => {
    const { impl } = recorder({ json: async () => ({ taskflow_profile: { agent_id: 2 } }) });
    await expect(requestMint("http://localhost:8000", 2, args, "t-1", impl)).rejects.toThrow(/no key/i);
  });
});

describe("exportHint", () => {
  // The whole point of the command: the operator must end up knowing how to
  // start the other terminal as the new identity.
  it("names the profile so the other terminal can be started as it", () => {
    expect(exportHint("bear")).toContain("TASKFLOW_PROFILE=bear");
  });
});
