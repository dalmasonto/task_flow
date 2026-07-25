import { describe, expect, it } from "vitest";
import { sessionIdentifier } from "./session-identifier.js";

describe("sessionIdentifier", () => {
  it("prefers the tmux pane so tools and mirror share ONE session row", () => {
    expect(
      sessionIdentifier({ pane: "%0", profileName: "main", host: "box", project: 1, agentId: 7 }),
    ).toBe("tmux:box:%0#p1.a7.main");
  });

  it("falls back to host:pid outside tmux", () => {
    expect(
      sessionIdentifier({
        pane: null,
        profileName: "main",
        host: "box",
        pid: 99,
        project: 1,
        agentId: 7,
      }),
    ).toBe("box:99#p1.a7.main");
  });

  it("gives two profiles in the SAME pane different identifiers", () => {
    // Without this the backend 409s on the second one (views.rs:1813) and
    // switching profiles in a pane would be impossible.
    const a = sessionIdentifier({
      pane: "%0",
      profileName: "main",
      host: "box",
      project: 1,
      agentId: 7,
    });
    const b = sessionIdentifier({
      pane: "%0",
      profileName: "bear",
      host: "box",
      project: 1,
      agentId: 8,
    });
    expect(a).not.toBe(b);
  });

  it("is stable for the same terminal and profile", () => {
    const opts = { pane: "%0", profileName: "bear", host: "box", project: 1, agentId: 8 };
    expect(sessionIdentifier(opts)).toBe(sessionIdentifier(opts));
  });

  it("gives two AGENTS in the same pane different identifiers", () => {
    // The profile NAME is not an identity: every `.taskflow.json` calls its
    // default profile `main`, so two repos on one machine — different projects,
    // different agents — used to compute the SAME identifier. The backend keys
    // identifiers globally and 409s when the row belongs to another agent
    // (views.rs:1813), so the second repo could never register: an unbounded
    // retry loop against a conflict that retrying cannot resolve.
    const claude = sessionIdentifier({
      pane: "%0",
      host: "Alpha",
      profileName: "main",
      project: 2,
      agentId: 1,
    });
    const builder = sessionIdentifier({
      pane: "%0",
      host: "Alpha",
      profileName: "main",
      project: 3,
      agentId: 2,
    });
    expect(builder).not.toBe(claude);
  });

  it("gives one agent in two checkouts different identifiers", () => {
    // Pane ids are numbered per tmux SERVER, so two servers both call their
    // first pane `%0`. Two checkouts sharing one agent id would then collide on
    // a single session row — no 409 (same agent reconnects), but the two
    // terminals fight over one row and one mirror. The config path is what
    // tells them apart.
    const here = sessionIdentifier({
      pane: "%0",
      host: "Alpha",
      profileName: "main",
      project: 3,
      agentId: 2,
      configPath: "/home/dalmas/E/projects/ethsafari/v2/.taskflow.json",
    });
    const there = sessionIdentifier({
      pane: "%0",
      host: "Alpha",
      profileName: "main",
      project: 3,
      agentId: 2,
      configPath: "/home/dalmas/E/projects/ethsafari/v3/.taskflow.json",
    });
    expect(there).not.toBe(here);
  });

  it("omits the location suffix when there is no config path", () => {
    // `configPath` is empty when a config was parsed from a string rather than
    // read from disk (config.ts:68). An empty suffix beats a hash of "".
    expect(
      sessionIdentifier({ pane: "%0", host: "box", profileName: "main", project: 1, agentId: 7 }),
    ).toBe("tmux:box:%0#p1.a7.main");
  });
});
