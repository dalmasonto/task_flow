import { describe, expect, it } from "vitest";
import { sessionIdentifier } from "./session-identifier.js";

describe("sessionIdentifier", () => {
  it("prefers the tmux pane so tools and mirror share ONE session row", () => {
    expect(sessionIdentifier({ pane: "%0", profileName: "main", host: "box" })).toBe(
      "tmux:box:%0#main",
    );
  });

  it("falls back to host:pid outside tmux", () => {
    expect(
      sessionIdentifier({ pane: null, profileName: "main", host: "box", pid: 99 }),
    ).toBe("box:99#main");
  });

  it("gives two profiles in the SAME pane different identifiers", () => {
    // Without this the backend 409s on the second one (views.rs:1813) and
    // switching profiles in a pane would be impossible.
    const a = sessionIdentifier({ pane: "%0", profileName: "main", host: "box" });
    const b = sessionIdentifier({ pane: "%0", profileName: "bear", host: "box" });
    expect(a).not.toBe(b);
  });

  it("is stable for the same terminal and profile", () => {
    const opts = { pane: "%0", profileName: "bear", host: "box" };
    expect(sessionIdentifier(opts)).toBe(sessionIdentifier(opts));
  });
});
