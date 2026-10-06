import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tool bodies are exercised END TO END — over a real MCP transport, through
 * the real zod schemas — because the parts that go wrong are the parts a helper
 * test cannot see: the ORDER two statements run in, which session id a tool
 * reaches for, and whether a refusal survives serialization. The reviewer
 * swapped `select_profile`'s roster lookup with its connect and got a clean
 * `tsc` and a green suite; that is what these cases exist to stop.
 *
 * Every collaborator that would touch the network, tmux, or the sticky-pick
 * file on disk is replaced at the module boundary (same idiom as
 * `runtime.test.ts`). No socket, no tmux, no real timer.
 */
const harness = vi.hoisted(() => ({
  /** Ordered log of the collaborator calls each tool makes. */
  calls: [] as string[],
  /**
   * The payload of each arrangement write the tools sent — the tagged operation
   * and any `base_version` — as JSON.
   */
  layoutOps: [] as string[],
  /**
   * The KEYS of that same payload. `JSON.stringify` DROPS a key whose value is
   * `undefined`, so a write carrying `base_version: undefined` and a write
   * carrying no `base_version` at all serialise to identical bytes; only the
   * own keys tell them apart, and the difference is the whole point of an
   * argument the route reads as `Option<i64>`.
   */
  layoutOpKeys: [] as string[][],
  agents: [] as Array<{
    id: number;
    display_name: string;
    identifier: string;
    status: string;
    last_seen_at: string | null;
  }>,
  listAgentsFails: false,
  registered: [] as Array<{ session_identifier: string }>,
  heartbeats: [] as Array<{ session: number; status?: string }>,
  connection: { state: "starting", attempts: 0 } as {
    state: string;
    attempts: number;
    session?: number;
    profile?: string;
  },
}));

vi.mock("./tmux.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmux.js")>()),
  // Outside tmux: the pane plays no part in these cases, and detecting one
  // would shell out.
  detectTmuxPane: async () => null,
}));

// `selectProfile` is the connect side of `select_profile`; it is recorded rather
// than run so the ORDER of the lookup and the connect is observable.
vi.mock("./runtime.js", () => ({
  selectProfile: async () => {
    harness.calls.push("selectProfile");
  },
}));

// The status a live connection would publish, under this test's control.
vi.mock("./connect.js", () => ({
  getConnectionStatus: () => ({ ...harness.connection }),
}));

// A remembered pick would resolve the ambiguity these cases depend on — and
// reading it touches the real filesystem and the real ppid.
vi.mock("./sessions-store.js", () => ({
  readStickyProfile: () => undefined,
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  class FakeClient {
    constructor(readonly options: { server: string; key: string }) {}
    async listAgents() {
      harness.calls.push("listAgents");
      if (harness.listAgentsFails) throw new Error("network error");
      return harness.agents;
    }
    async whoami() {
      harness.calls.push("whoami");
      return {
        agent_id: 1,
        display_name: "Claude (main)",
        identifier: "agent:2:x:main",
        project: 2,
        status: "connected",
      };
    }
    async registerSession(input: { session_identifier: string }) {
      harness.calls.push("registerSession");
      harness.registered.push(input);
      return { id: 501, session_identifier: input.session_identifier, status: "connected" };
    }
    async heartbeat(session: number, status?: string) {
      harness.calls.push(`heartbeat:${session}`);
      harness.heartbeats.push({ session, status });
      return { id: session, session_identifier: "x", status: "connected" };
    }
    async listTasks() {
      harness.calls.push("listTasks");
      return [];
    }
    async readDesignLayout(project: number) {
      // The project is recorded, not just the call: a layout read that reached
      // the wrong project would answer with somebody else's board.
      harness.calls.push(`readDesignLayout:${project}`);
      return { groups: [{ id: "g1", name: "Auth", routes: ["/settings"] }] };
    }
    async writeLayoutOp(input: { project: number; op?: unknown; ops?: unknown[]; base_version?: number }) {
      // The project is asserted through `calls` — it is resolved from `whoami`
      // and handed in, not chosen here — and the REST is recorded for the shape
      // assertions: an operation carrying a key nobody asked for would
      // round-trip through the backend and never be seen otherwise.
      const { project, ...payload } = input;
      harness.calls.push(`writeLayoutOp:${project}`);
      harness.layoutOps.push(JSON.stringify(payload));
      harness.layoutOpKeys.push(Object.keys(payload));
      return { ok: true, version: 2, changed: { groups: ["g1"], routes: [] } };
    }
    async trashDesignPage(project: number, route: string, reason: string) {
      harness.calls.push(`trashDesignPage:${project}:${route}:${reason}`);
      return { ok: true, trashed: "pages/x.html" };
    }
    async deleteDesignComponent(project: number, name: string, reason: string) {
      // Every argument is recorded: a delete that dropped the reason would be
      // accepted by the backend and never seen here, and a delete aimed at the
      // wrong project would name someone else's component.
      harness.calls.push(`deleteDesignComponent:${project}:${name}:${reason}`);
      return { ok: true, deleted: `components/${name}.js` };
    }
    async writeDesignAsset(
      project: number,
      path: string,
      content: string,
      baseVersion?: number,
    ) {
      harness.calls.push(
        `writeDesignAsset:${project}:${path}:${content.length}:${baseVersion ?? "none"}`,
      );
      return { ok: true };
    }
  }
  return { ...actual, TaskflowClient: FakeClient };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  ambiguityRefusal,
  buildServer,
  collisionWarning,
  isLiveAgentStatus,
  markInUse,
} from "./server.js";
import type { AgentSummary } from "./client.js";
import type { ProfileChoice } from "./config.js";

const CHOICES: ProfileChoice[] = [
  { name: "main", display_name: "Claude (main)", recommended: true },
  { name: "bear", display_name: "Claude (bear)", recommended: false },
];

describe("ambiguityRefusal", () => {
  it("names the error so the model can branch on it", () => {
    expect(JSON.parse(ambiguityRefusal(CHOICES)).error).toBe("profile_ambiguous");
  });

  it("lists every profile with its display name and recommendation", () => {
    const body = JSON.parse(ambiguityRefusal(CHOICES));
    expect(body.profiles).toEqual(CHOICES);
  });

  it("tells the model to ask its human and name the follow-up call", () => {
    const body = JSON.parse(ambiguityRefusal(CHOICES));
    expect(body.hint).toMatch(/ask/i);
    expect(body.hint).toMatch(/select_profile/);
  });
});

/** An agent row in whatever state the backend chose to report. */
function agent(status: string, id = 1): AgentSummary {
  return {
    id,
    display_name: "Claude (main)",
    identifier: "agent:2:x:main",
    status,
    last_seen_at: null,
  };
}

describe("isLiveAgentStatus", () => {
  // The backend reports a LIVE agent's stored status, which is connected OR
  // idle OR busy (`effective_agent_status`); only a dead one reads `offline`.
  // Treating `connected` as the whole of "live" made the collision check
  // silently no-op for the actively-working terminal it exists to protect.
  it("counts every status a live agent can report", () => {
    expect(isLiveAgentStatus("connected")).toBe(true);
    expect(isLiveAgentStatus("idle")).toBe(true);
    expect(isLiveAgentStatus("busy")).toBe(true);
  });

  it("does not count dead or administratively-held states", () => {
    for (const status of ["offline", "blocked", "revoked", "", "something_new"]) {
      expect(isLiveAgentStatus(status), status).toBe(false);
    }
  });
});

describe("markInUse", () => {
  it("flags profiles whose agent has a live session", () => {
    const marked = markInUse(CHOICES, [agent("connected")], { main: 1, bear: 2 });
    expect(marked.find((p) => p.name === "main")?.in_use).toBe(true);
    expect(marked.find((p) => p.name === "bear")?.in_use).toBe(false);
  });

  it("flags a BUSY or IDLE agent too — those are live, not free", () => {
    for (const status of ["busy", "idle"]) {
      const marked = markInUse(CHOICES, [agent(status)], { main: 1, bear: 2 });
      expect(marked.find((p) => p.name === "main")?.in_use, status).toBe(true);
    }
  });

  it("leaves an offline agent free", () => {
    const marked = markInUse(CHOICES, [agent("offline")], { main: 1, bear: 2 });
    expect(marked.find((p) => p.name === "main")?.in_use).toBe(false);
  });

  it("omits in_use entirely when liveness could not be determined", () => {
    const marked = markInUse(CHOICES, null, { main: 1, bear: 2 });
    expect(marked.every((p) => p.in_use === undefined)).toBe(true);
  });
});

describe("collisionWarning", () => {
  it("says nothing when the identity is free", () => {
    expect(collisionWarning("bear", null)).toBeUndefined();
  });

  it("names the live session and the concrete consequence", () => {
    const warning = collisionWarning("bear", {
      id: 2,
      display_name: "Claude (bear)",
      identifier: "agent:2:x:bear",
      status: "connected",
      last_seen_at: "2026-07-24T09:00:00Z",
    });
    expect(warning).toMatch(/bear/);
    expect(warning).toMatch(/inbox|read cursor/i);
    expect(warning).toMatch(/tell your human/i);
  });
});

// ---- end to end, over an in-memory MCP transport ----

/** A throwaway repo whose `.taskflow.json` defines two identities. */
function twoProfileRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "taskflow-server-"));
  const configPath = join(dir, ".taskflow.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      server: "http://localhost:8000",
      project: 2,
      default_profile: "main",
      profiles: {
        main: { agent_id: 1, key: "tfk_main", display_name: "Claude (main)" },
        reviewer: { agent_id: 2, key: "tfk_rev", display_name: "Reviewer" },
      },
    }),
  );
  return configPath;
}

/** A connected MCP client talking to a server built over `twoProfileRepo()`. */
async function connectedClient(): Promise<Client> {
  // `env: {}` and an explicit configPath: the real environment must not decide
  // which identity this server resolves to.
  const server = buildServer({ configPath: twoProfileRepo(), env: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "taskflow-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The tool result's single text block, parsed as the JSON the tools return. */
function body(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

const LIVE_MAIN = {
  id: 1,
  display_name: "Claude (main)",
  identifier: "agent:2:x:main",
  // The status an actively-working terminal reports — NOT `connected`.
  status: "busy",
  last_seen_at: "2026-07-24T09:00:00Z",
};

beforeEach(() => {
  harness.calls.length = 0;
  harness.layoutOps.length = 0;
  harness.layoutOpKeys.length = 0;
  harness.agents = [];
  harness.listAgentsFails = false;
  harness.registered.length = 0;
  harness.heartbeats.length = 0;
  harness.connection = { state: "starting", attempts: 0 };
});

describe("select_profile (end to end)", () => {
  it("looks up the live agent BEFORE it connects", async () => {
    // Run the other way round, `selectProfile` has already registered a session
    // for this very agent, so the lookup finds OUR OWN row and warns about a
    // collision with ourselves on every single call.
    const client = await connectedClient();
    await client.callTool({ name: "select_profile", arguments: { profile: "main" } });
    expect(harness.calls).toEqual(["listAgents", "selectProfile"]);
  });

  it("warns — and does NOT refuse — when the identity is already live", async () => {
    harness.agents = [LIVE_MAIN];
    const client = await connectedClient();
    const result = await client.callTool({
      name: "select_profile",
      arguments: { profile: "main" },
    });
    // Refusing would lock a human out of their own identity for up to the
    // liveness window after a crash. The collision is recoverable; being
    // unable to reconnect is not.
    expect(result.isError).toBeFalsy();
    const parsed = body(result);
    expect(parsed.selected).toBe("main");
    expect(parsed.warning).toMatch(/already has a live session/);
  });

  it("says nothing when the identity is free", async () => {
    harness.agents = [{ ...LIVE_MAIN, status: "offline" }];
    const client = await connectedClient();
    const parsed = body(
      await client.callTool({ name: "select_profile", arguments: { profile: "main" } }),
    );
    expect(parsed.warning).toBeUndefined();
  });

  it("rejects an EMPTY profile instead of silently selecting the default", async () => {
    // `chooseProfileName` treats "" as absent and falls back to
    // `default_profile ?? "main"` — the exact silent guess this tool removes.
    const client = await connectedClient();
    const result = await client.callTool({ name: "select_profile", arguments: { profile: "" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/validation|Invalid arguments/i);
    // Nothing was looked up and, crucially, nothing was connected or stickied.
    expect(harness.calls).toEqual([]);
  });

  it("rejects a WHITESPACE-ONLY profile the same way as empty", async () => {
    // `.min(1)` alone accepts "   " — it is one space-bar away from the exact
    // silent default-identity guess this tool exists to remove.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "select_profile",
      arguments: { profile: "   " },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/validation|Invalid arguments/i);
    // Nothing was looked up and, crucially, nothing was connected or stickied.
    expect(harness.calls).toEqual([]);
  });

  it("reports the connection state it observed rather than asserting success", async () => {
    // With the backend down this reads `retrying` indefinitely; a note that
    // says "Connected." beside it is simply false.
    harness.connection = { state: "retrying", attempts: 3, detail: "fetch failed" } as never;
    const client = await connectedClient();
    const parsed = body(
      await client.callTool({ name: "select_profile", arguments: { profile: "main" } }),
    );
    expect(parsed.note).not.toMatch(/^Connected\./);
    expect(parsed.note).toMatch(/retrying/);
    expect(parsed.note).toMatch(/this identity/i);
  });

  it("says Connected once the connection really is active", async () => {
    harness.connection = { state: "active", attempts: 1, session: 501, profile: "main" };
    const client = await connectedClient();
    const parsed = body(
      await client.callTool({ name: "select_profile", arguments: { profile: "main" } }),
    );
    expect(parsed.note).toMatch(/^Connected\./);
  });
});

describe("profile ambiguity (end to end)", () => {
  it("refuses to guess, and names the follow-up call", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(result.isError).toBe(true);
    const parsed = body(result);
    expect(parsed.error).toBe("profile_ambiguous");
    expect(parsed.hint).toMatch(/select_profile/);
    // The refusal replaces the work, it does not precede it.
    expect(harness.calls).not.toContain("listTasks");
  });

  it("marks the identity another terminal is BUSY as in a live session", async () => {
    harness.agents = [LIVE_MAIN];
    const client = await connectedClient();
    const parsed = body(await client.callTool({ name: "list_tasks", arguments: {} }));
    const profiles = parsed.profiles as ProfileChoice[];
    expect(profiles.find((p) => p.name === "main")?.in_use).toBe(true);
    expect(profiles.find((p) => p.name === "reviewer")?.in_use).toBe(false);
  });

  it("does the roster round-trip ONCE, not on every refused call", async () => {
    // Each refusal used to pay a listAgents round-trip (15s client timeout)
    // before returning, for the whole time the ambiguity lasted.
    const client = await connectedClient();
    await client.callTool({ name: "list_tasks", arguments: {} });
    await client.callTool({ name: "list_channels", arguments: {} });
    await client.callTool({ name: "list_agents", arguments: {} });
    expect(harness.calls.filter((c) => c === "listAgents")).toHaveLength(1);
  });

  it("retries the roster after a failed fetch rather than caching the failure", async () => {
    harness.listAgentsFails = true;
    const client = await connectedClient();
    const first = body(await client.callTool({ name: "list_tasks", arguments: {} }));
    // Liveness is a courtesy: unknown means `in_use` is omitted, never guessed.
    expect((first.profiles as ProfileChoice[]).every((p) => p.in_use === undefined)).toBe(true);
    harness.listAgentsFails = false;
    harness.agents = [LIVE_MAIN];
    const second = body(await client.callTool({ name: "list_tasks", arguments: {} }));
    expect((second.profiles as ProfileChoice[]).find((p) => p.name === "main")?.in_use).toBe(true);
  });

  it("resolves an explicit profile argument and does the work", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "list_tasks", arguments: { profile: "reviewer" } });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain("listTasks");
  });
});

describe("session reuse (end to end)", () => {
  it("does NOT hand another profile's session to a call made as this one", async () => {
    // The live connection is `main`'s. A heartbeat as `reviewer` that sends
    // main's session id under reviewer's credential is a 403 from
    // `load_owned_session` — and before Task 7 this path registered its own
    // session and worked.
    harness.connection = { state: "active", attempts: 1, session: 999, profile: "main" };
    const client = await connectedClient();
    await client.callTool({ name: "heartbeat", arguments: { profile: "reviewer" } });
    expect(harness.registered).toHaveLength(1);
    expect(harness.heartbeats).toEqual([{ session: 501, status: undefined }]);
  });

  it("reuses the connection's session when it IS this profile's", async () => {
    // One session row per process for the connected identity — the point of
    // the reuse in the first place.
    harness.connection = { state: "active", attempts: 1, session: 999, profile: "main" };
    const client = await connectedClient();
    await client.callTool({ name: "heartbeat", arguments: { profile: "main", status: "busy" } });
    expect(harness.registered).toEqual([]);
    expect(harness.heartbeats).toEqual([{ session: 999, status: "busy" }]);
  });

  it("registers once and caches it when there is no connection at all", async () => {
    const client = await connectedClient();
    await client.callTool({ name: "heartbeat", arguments: { profile: "reviewer" } });
    await client.callTool({ name: "heartbeat", arguments: { profile: "reviewer" } });
    expect(harness.registered).toHaveLength(1);
    expect(harness.heartbeats).toEqual([
      { session: 501, status: undefined },
      { session: 501, status: undefined },
    ]);
  });
});

describe("the profile argument's description", () => {
  it("does not promise a default, and names the refusal omitting it can return", async () => {
    // "(default: main)" is false for a multi-profile repo and tells the model
    // precisely the wrong thing — that omitting it is safe.
    const client = await connectedClient();
    const tools = await client.listTools();
    const whoami = tools.tools.find((t) => t.name === "whoami");
    const description = (
      whoami?.inputSchema.properties as Record<string, { description?: string }> | undefined
    )?.profile?.description;
    expect(description).toBeDefined();
    expect(description).not.toMatch(/default: main/);
    expect(description).toMatch(/profile_ambiguous/);
  });
});

describe("update_task", () => {
  it("requires only the task id, so an edit names just what it changes", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const update = tools.tools.find((t) => t.name === "update_task");

    expect(update, "update_task must be registered").toBeDefined();
    const props = Object.keys(update?.inputSchema.properties ?? {});
    expect(props).toEqual(
      expect.arrayContaining(["task", "title", "description", "notes", "priority", "files"]),
    );
    const required = (update?.inputSchema.required ?? []) as string[];
    expect(required).toContain("task");
    expect(required).not.toContain("title");
  });

  it("refuses a call that names nothing to change", async () => {
    // A no-op that returns the task unchanged reads as success and hides the
    // forgotten argument, so it has to be an error rather than a silent pass.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "update_task",
      // An explicit profile: this harness defines two, so omitting it returns
      // the ambiguity refusal before the tool's own validation is reached.
      arguments: { task: 1, profile: "main" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Nothing to update/);
  });
});

describe("design_read_layout", () => {
  // The gap this tool closes is not a missing endpoint — it is an agent not
  // knowing the arrangement is something it CAN ask about, having only ever
  // seen design_list_components' flat, group-less, order-less array. So the
  // description is load-bearing rather than decorative, and these assertions
  // are on it rather than on the wiring alone.
  it("is registered, and says it answers the grouping and the order", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_read_layout");

    expect(tool, "design_read_layout must be registered").toBeDefined();
    const description = tool?.description ?? "";
    expect(description).toMatch(/group/i);
    expect(description).toMatch(/order/i);
    // It names the tool it is NOT, so an agent that already knows that one
    // knows this is the different question.
    expect(description).toMatch(/design_list_components/);
    // It points at the write tools rather than claiming there are none. This
    // sentence used to read "there is no tool that writes it", which is exactly
    // the kind of prose that goes stale silently.
    expect(description).toMatch(/design_create_group/);
    expect(description).not.toMatch(/no tool that writes it/i);
  });

  it("reads the layout of THIS credential's project", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_read_layout",
      // The harness defines two profiles, so an omitted one returns the
      // ambiguity refusal before the tool body is reached.
      arguments: { profile: "main" },
    });

    expect(result.isError).toBeFalsy();
    // The FakeClient's `whoami` reports project 2 — the project the tool must
    // have resolved to before it asked for anything.
    expect(harness.calls).toContain("readDesignLayout:2");
    expect(JSON.stringify(result.content)).toMatch(/Auth/);
  });
});

describe("design_write_page", () => {
  // The defect this pins is a description that lied by OMISSION: the tool has
  // always CREATED routes (writing pages/billing.html IS creating /billing),
  // and nothing said so, so an agent reported it could not create a screen.
  // Capability the caller cannot discover is indistinguishable from capability
  // that is absent, which is exactly what the gap analysis recorded.
  it("says plainly that it creates a route that does not exist yet", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_write_page");

    expect(tool, "design_write_page must be registered").toBeDefined();
    const description = tool?.description ?? "";
    // The claim, not a synonym for it: an agent has to read that THIS call is
    // what brings a new screen into being, and that there is no other tool to
    // go looking for.
    expect(description).toMatch(/creates? (it|the route|a route|a new route)/i);
    expect(description).toMatch(/does not exist/i);
    // And the route argument says the same thing where an agent reads it last.
    const routeArg = tool?.inputSchema.properties?.route as { description?: string };
    expect(routeArg?.description ?? "").toMatch(/creat/i);
  });
});

describe("design_get_tokens", () => {
  it("says the response carries the authoring guide, not only the scale", async () => {
    // The guide is served in this response and nowhere else, and it answers
    // questions no manifest can (how pages link, how a back control is
    // written, what a page may load). An agent that believes the call returns
    // only variables skims straight past it.
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_get_tokens");

    expect(tool, "design_get_tokens must be registered").toBeDefined();
    expect(tool?.description ?? "").toMatch(/guide/);
  });
});

describe("design_delete_component", () => {
  it("is registered, and warns that a still-referenced component is refused", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_delete_component");

    expect(tool, "design_delete_component must be registered").toBeDefined();
    const description = tool?.description ?? "";
    // The refusal is the whole safety property, and it is not guessable: a
    // tool that only said "deletes a component" would be called on a component
    // pages still use, and the agent would have no idea why it came back 409.
    expect(description).toMatch(/refus/i);
    expect(description).toMatch(/route/i);
    expect(description).toMatch(/reason/);
  });

  it("does not claim the stranded page is unrecoverable", async () => {
    // A page left holding a deleted component is stuck for edits that KEEP the
    // reference — a write that removes the tag is accepted (proved in
    // `phase3_agent_surface.rs`). The earlier wording said "can never be written
    // again", and the overstatement is the harmful direction: it points an agent
    // at deleting and recreating the page when the repair is a rewrite.
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_delete_component");
    const description = tool?.description ?? "";

    expect(description).not.toMatch(/never be written|permanently/i);
    // And the bound positively, because "it is not permanent" alone does not
    // tell an agent what to do instead.
    expect(description).toMatch(/removes it is accepted|removes the tag/i);
  });

  it("passes the name and the reason through, aimed at the credential's project", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_delete_component",
      // The harness defines two profiles, so an omitted one returns the
      // ambiguity refusal before the tool body is reached.
      arguments: { name: "app-header", reason: "nothing uses it", profile: "main" },
    });

    expect(result.isError).toBeFalsy();
    // `whoami` reports project 2 — the project this credential pins.
    expect(harness.calls).toContain("deleteDesignComponent:2:app-header:nothing uses it");
  });
});

describe("webfont guidance", () => {
  it("steers a webfont to styles/resources.json, never a per-page <link>", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const desc = (name: string) => tools.tools.find((t) => t.name === name)?.description ?? "";
    expect(desc("design_write_asset")).toMatch(/head of EVERY page/);
    expect(desc("design_write_asset")).toMatch(/@fontsource-variable\/inter@5\/index\.css/);
    expect(desc("design_write_page")).toMatch(/Do NOT put a webfont <link>/);
    expect(desc("design_write_tokens")).toMatch(/typography\.font-sans/);
    expect(desc("design_get_tokens")).toMatch(/`resources`/);
  });
});

describe("design_write_asset", () => {
  it("is registered, and names both writable shapes", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_write_asset");

    expect(tool, "design_write_asset must be registered").toBeDefined();
    const description = tool?.description ?? "";
    // Both halves of the gap this closes. `styles/resources.json` especially:
    // it is the one the token tool does NOT write, and a caller who assumed
    // otherwise would keep looking for a tool that does not exist.
    expect(description).toMatch(/assets\//);
    expect(description).toMatch(/resources\.json/);
    // The wire shape, which is not guessable: content is TEXT, so an agent
    // that sent raw PNG bytes would store a mangled file.
    expect(description).toMatch(/base64/);
  });

  it("sends the path and content for the credential's project", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_write_asset",
      arguments: { path: "logo.svg", content: "<svg/>", profile: "main" },
    });

    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain("writeDesignAsset:2:logo.svg:6:none");
  });
});

describe("create_task", () => {
  it("accepts files so a spec can be hung on the task it belongs to", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const create = tools.tools.find((t) => t.name === "create_task");

    const props = Object.keys(create?.inputSchema.properties ?? {});
    expect(props).toEqual(expect.arrayContaining(["title", "files", "notes"]));
  });
});

describe("layout write tools", () => {
  // These go over the REAL transport like every other case in this file — the
  // parts that go wrong are the parts a helper test cannot see, and for these
  // tools that is the SHAPE of the operation object that reaches the client.

  it("registers all six", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const name of [
      "design_create_group",
      "design_update_group",
      "design_reorder_group",
      "design_reorder_page",
      "design_delete_group",
      "design_arrange",
    ]) {
      expect(names, `${name} must be registered`).toContain(name);
    }
  });

  it("says the version is optional, because omitting it is the normal case", async () => {
    // An agent that never read must not be told it has to read first.
    const client = await connectedClient();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "design_reorder_page");
    const description = tool?.description ?? "";
    expect(description).toMatch(/base_version/i);
    expect(description).toMatch(/optional|omit/i);
  });

  it("sends an operation and nothing else", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_create_group",
      arguments: { profile: "main", name: "Player" },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain("writeLayoutOp:2");
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { create_group: { name: "Player" } },
    });
  });

  it("forwards a supplied base_version untouched", async () => {
    const client = await connectedClient();
    await client.callTool({
      name: "design_reorder_group",
      arguments: { profile: "main", group_id: "g1", position: 2, base_version: 7 },
    });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      base_version: 7,
      op: { reorder_group: { group_id: "g1", position: 2 } },
    });
  });

  it("names reorder_page's fields the way the route expects", async () => {
    // This is the one operation with optional fields INSIDE it, and the only
    // place a field name can go wrong silently: serde IGNORES a field it does
    // not know, so a `position` sent under any other name arrives as "no
    // position asked for" — the page is appended instead of placed, and the
    // write reports success for an edit nobody asked for.
    const client = await connectedClient();
    await client.callTool({
      name: "design_reorder_page",
      arguments: { profile: "main", route: "/settings", position: 2 },
    });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { reorder_page: { route: "/settings", position: 2 } },
    });
  });

  it("#501: design_delete_page trashes by route and carries the reason", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_delete_page",
      arguments: { profile: "main", route: "/draft", reason: "superseded by /settings" },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.calls).toContain("trashDesignPage:2:/draft:superseded by /settings");
  });

  it("#501: design_delete_page refuses a missing reason before sending", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_delete_page",
      arguments: { profile: "main", route: "/draft", reason: "no" },
    });
    expect(result.isError).toBe(true);
    expect(harness.calls.some((c) => c.startsWith("trashDesignPage:") && c.endsWith(":no"))).toBe(false);
  });

  it("#501: design_delete_group sends a delete_group op", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_delete_group",
      arguments: { profile: "main", group_id: "g3" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { delete_group: { group_id: "g3" } },
    });
  });

  it("#501: design_arrange sends the batch as `ops`, in order, and no `op`", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_arrange",
      arguments: {
        profile: "main",
        base_version: 4,
        ops: [
          { reorder_page: { route: "/a", group_id: "g1" } },
          { reorder_page: { route: "/b", group_id: "g1", position: 1 } },
          { delete_group: { group_id: "g2" } },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      base_version: 4,
      ops: [
        { reorder_page: { route: "/a", group_id: "g1" } },
        { reorder_page: { route: "/b", group_id: "g1", position: 1 } },
        { delete_group: { group_id: "g2" } },
      ],
    });
  });

  it("#501: design_arrange refuses an op the route would not know, before sending", async () => {
    const client = await connectedClient();
    const before = harness.layoutOps.length;
    const result = await client.callTool({
      name: "design_arrange",
      arguments: { profile: "main", ops: [{ reorder_page: { route: "/a" } }] },
    });
    expect(result.isError).toBe(true);
    const typo = await client.callTool({
      name: "design_arrange",
      arguments: { profile: "main", ops: [{ reorder_page: { route: "/a", postion: 2 } }] },
    });
    expect(typo.isError).toBe(true);
    expect(harness.layoutOps.length).toBe(before);
  });

  it("omits base_version entirely rather than sending null", async () => {
    // `null` would fail the route's `Option<i64>` deserialisation differently
    // from an absent key, so "not supplied" has to mean "key absent" — and the
    // KEYS are the only place that shows. `JSON.stringify` drops a key whose
    // value is `undefined`, so a tool that passed `base_version: undefined`
    // would serialise byte-for-byte like one that passed nothing, and an
    // assertion on the parsed JSON would pass either way and pin nothing.
    const client = await connectedClient();
    await client.callTool({
      name: "design_update_group",
      arguments: { profile: "main", group_id: "g1", name: "X" },
    });
    expect(harness.layoutOpKeys.at(-1)).toEqual(["op"]);
  });

  it("refuses a reorder_page that names neither a group nor a position", async () => {
    // The backend answers this with a 400, so a schema that let it through
    // would send every such call to a refusal it already knows the answer to.
    // The refusal is in the ARGUMENTS, which is where an agent can be told
    // early, and the message names what is missing.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "design_reorder_page",
      arguments: { profile: "main", route: "/settings" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/group_id/);
    expect(JSON.stringify(result.content)).toMatch(/position/);
    // And nothing was written: the refusal came before the client was reached,
    // so there is no operation for the backend to reject.
    expect(harness.layoutOps).toHaveLength(0);
  });

  it("refuses a position below 1 on both reorder tools", async () => {
    // `position` is 1-based and the backend reads it as `usize`, so a negative
    // never reaches the range check that names the valid range: it fails
    // deserialisation at the extractor and the agent is told about a type
    // instead of about the slot. Refused in the ARGUMENTS, where the answer is
    // about the number it sent.
    const client = await connectedClient();
    for (const call of [
      {
        name: "design_reorder_group",
        arguments: { profile: "main", group_id: "g1", position: -1 },
      },
      {
        name: "design_reorder_page",
        arguments: { profile: "main", route: "/settings", position: -1 },
      },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
    }
    // Neither write left: both were refused before the client was reached.
    expect(harness.layoutOps).toHaveLength(0);
  });
});

describe("#508 user-flow tools", () => {
  it("registers design_link_pages and design_unlink_pages, and explains the flow", async () => {
    const client = await connectedClient();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("design_link_pages");
    expect(names).toContain("design_unlink_pages");
    const link = tools.tools.find((t) => t.name === "design_link_pages");
    expect(link?.description ?? "").toMatch(/Flow canvas/);
    expect(link?.description ?? "").toMatch(/new user/);
    const read = tools.tools.find((t) => t.name === "design_read_layout");
    expect(read?.description ?? "").toMatch(/edges/);
    expect(read?.description ?? "").toMatch(/positions/);
  });

  it("design_link_pages sends a link_pages op, omitting an absent label", async () => {
    const client = await connectedClient();
    const labelled = await client.callTool({
      name: "design_link_pages",
      arguments: { profile: "main", from: "/welcome", to: "/signup", label: "new user" },
    });
    expect(labelled.isError).toBeFalsy();
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { link_pages: { from: "/welcome", to: "/signup", label: "new user" } },
    });
    await client.callTool({
      name: "design_link_pages",
      arguments: { profile: "main", from: "/welcome", to: "/login" },
    });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { link_pages: { from: "/welcome", to: "/login" } },
    });
  });

  it("design_unlink_pages sends by edge_id or by from+to, and refuses a mix", async () => {
    const client = await connectedClient();
    await client.callTool({ name: "design_unlink_pages", arguments: { profile: "main", edge_id: "e1" } });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({ op: { unlink_pages: { edge_id: "e1" } } });
    await client.callTool({
      name: "design_unlink_pages",
      arguments: { profile: "main", from: "/a", to: "/b" },
    });
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({
      op: { unlink_pages: { from: "/a", to: "/b" } },
    });

    const before = harness.layoutOps.length;
    for (const args of [{}, { edge_id: "e1", from: "/a", to: "/b" }, { from: "/a" }]) {
      const result = await client.callTool({ name: "design_unlink_pages", arguments: { profile: "main", ...args } });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.layoutOps.length).toBe(before);
  });

  it("design_arrange accepts the four flow ops in the route's wire shape", async () => {
    const client = await connectedClient();
    const ops = [
      { link_pages: { from: "/welcome", to: "/signup", label: "new user" } },
      { unlink_pages: { edge_id: "e1" } },
      { unlink_pages: { from: "/a", to: "/b" } },
      { update_link: { edge_id: "e2", label: "existing user" } },
      { update_link: { edge_id: "e2" } },
      { place_page: { route: "/welcome", x: 0, y: -120.5 } },
    ];
    const result = await client.callTool({ name: "design_arrange", arguments: { profile: "main", ops } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(harness.layoutOps.at(-1) ?? "{}")).toEqual({ ops });
  });

  it("design_arrange refuses malformed flow ops before sending (strict shapes)", async () => {
    const client = await connectedClient();
    const before = harness.layoutOps.length;
    for (const op of [
      { link_pages: { from: "/a" } },
      { link_pages: { from: "/a", to: "/b", lable: "typo" } },
      { unlink_pages: { edge_id: "e1", from: "/a", to: "/b" } },
      { place_page: { route: "/a", x: 1 } },
      { place_page: { route: "/a", x: "1", y: 2 } },
      { update_link: { label: "x" } },
    ]) {
      const result = await client.callTool({ name: "design_arrange", arguments: { profile: "main", ops: [op] } });
      expect(result.isError, JSON.stringify(op)).toBe(true);
    }
    expect(harness.layoutOps.length).toBe(before);
  });
});

describe("design_guide", () => {
  it("is registered with an optional topic, and page writes teach shadcn classes", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const guide = tools.find((t) => t.name === "design_guide");
    expect(guide).toBeDefined();
    expect((guide?.inputSchema.required ?? []) as string[]).not.toContain("topic");
    const page = tools.find((t) => t.name === "design_write_page");
    expect(page?.description).toContain("bg-primary");
    expect(page?.description).not.toContain("bg-[var(--accent)]");
  });
});
