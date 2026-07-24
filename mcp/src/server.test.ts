import { describe, expect, it } from "vitest";
import { ambiguityRefusal, collisionWarning, markInUse } from "./server.js";
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

describe("markInUse", () => {
  it("flags profiles whose agent has a live session", () => {
    const marked = markInUse(
      CHOICES,
      [
        {
          id: 1,
          display_name: "Claude (main)",
          identifier: "agent:2:x:main",
          status: "connected",
          last_seen_at: null,
        },
      ],
      { main: 1, bear: 2 },
    );
    expect(marked.find((p) => p.name === "main")?.in_use).toBe(true);
    expect(marked.find((p) => p.name === "bear")?.in_use).toBe(false);
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
