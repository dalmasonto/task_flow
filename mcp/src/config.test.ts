import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseConfig,
  chooseProfileName,
  resolveProfile,
  resolveProfileOrAsk,
  findConfigPath,
  loadProfile,
  ConfigError,
  type TaskflowConfig,
} from "./config.js";

const SAMPLE: TaskflowConfig = {
  server: "http://localhost:8000",
  project: 1,
  default_profile: "main",
  profiles: {
    main: { agent_id: 12, key: "tfk_aaa_secret", display_name: "Builder" },
    reviewer: { agent_id: 13, key: "tfk_bbb_secret", display_name: "Reviewer" },
  },
};

describe("parseConfig", () => {
  it("accepts a valid config", () => {
    const cfg = parseConfig(JSON.stringify(SAMPLE));
    expect(cfg.project).toBe(1);
    expect(Object.keys(cfg.profiles)).toEqual(["main", "reviewer"]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseConfig("{ not json")).toThrow(ConfigError);
  });

  it("rejects a config with no profiles", () => {
    expect(() =>
      parseConfig(JSON.stringify({ server: "s", project: 1, profiles: {} })),
    ).toThrow(ConfigError);
  });

  it("rejects a profile missing a key", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({ server: "s", project: 1, profiles: { main: { agent_id: 1 } } }),
      ),
    ).toThrow(ConfigError);
  });
});

describe("chooseProfileName precedence", () => {
  it("uses default_profile when nothing else is set", () => {
    expect(chooseProfileName(SAMPLE, { env: {} })).toBe("main");
  });

  it("falls back to 'main' when no default_profile and no override", () => {
    const noDefault = { ...SAMPLE, default_profile: undefined };
    expect(chooseProfileName(noDefault, { env: {} })).toBe("main");
  });

  it("TASKFLOW_PROFILE env overrides default_profile", () => {
    expect(chooseProfileName(SAMPLE, { env: { TASKFLOW_PROFILE: "reviewer" } })).toBe("reviewer");
  });

  it("explicit profile arg overrides the env var", () => {
    expect(
      chooseProfileName(SAMPLE, { profile: "main", env: { TASKFLOW_PROFILE: "reviewer" } }),
    ).toBe("main");
  });

  it("ignores blank arg / env values", () => {
    expect(chooseProfileName(SAMPLE, { profile: "  ", env: { TASKFLOW_PROFILE: "" } })).toBe("main");
  });
});

describe("resolveProfile", () => {
  it("flattens the chosen profile", () => {
    const r = resolveProfile(SAMPLE, { env: {} });
    expect(r).toMatchObject({
      server: "http://localhost:8000",
      project: 1,
      profileName: "main",
      agentId: 12,
      key: "tfk_aaa_secret",
      displayName: "Builder",
    });
  });

  it("applies the env override end to end", () => {
    const r = resolveProfile(SAMPLE, { env: { TASKFLOW_PROFILE: "reviewer" } });
    expect(r.profileName).toBe("reviewer");
    expect(r.agentId).toBe(13);
  });

  it("trims a trailing slash off the server", () => {
    const r = resolveProfile({ ...SAMPLE, server: "http://localhost:8000/" }, { env: {} });
    expect(r.server).toBe("http://localhost:8000");
  });

  it("defaults displayName to the profile name when absent", () => {
    const cfg = {
      ...SAMPLE,
      profiles: { main: { agent_id: 1, key: "tfk_x_y" } },
    };
    expect(resolveProfile(cfg, { env: {} }).displayName).toBe("main");
  });

  it("throws a clear error for a missing profile", () => {
    expect(() => resolveProfile(SAMPLE, { profile: "ghost", env: {} })).toThrow(
      /Profile "ghost" is not defined/,
    );
  });
});

describe("findConfigPath / loadProfile", () => {
  it("finds .taskflow.json by walking up from a nested dir", () => {
    const root = mkdtempSync(join(tmpdir(), "taskflow-cfg-"));
    writeFileSync(join(root, ".taskflow.json"), JSON.stringify(SAMPLE));
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    const found = findConfigPath({ startDir: nested, env: {} });
    expect(found).toBe(join(root, ".taskflow.json"));

    const resolved = loadProfile({ startDir: nested, env: { TASKFLOW_PROFILE: "reviewer" } });
    expect(resolved.profileName).toBe("reviewer");
    expect(resolved.agentId).toBe(13);
  });

  it("honors an explicit configPath", () => {
    const root = mkdtempSync(join(tmpdir(), "taskflow-cfg-"));
    const path = join(root, "custom.taskflow.json");
    writeFileSync(path, JSON.stringify(SAMPLE));
    expect(findConfigPath({ configPath: path, env: {} })).toBe(path);
  });

  it("throws when no config file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "taskflow-empty-"));
    expect(() => findConfigPath({ startDir: root, env: {} })).toThrow(ConfigError);
  });
});

const TWO_PROFILES: TaskflowConfig = {
  server: "http://localhost:8000",
  project: 2,
  default_profile: "main",
  profiles: {
    main: { agent_id: 1, key: "tfk_a", display_name: "Claude (main)" },
    bear: { agent_id: 2, key: "tfk_b", display_name: "Claude (bear)" },
  },
};

const ONE_PROFILE: TaskflowConfig = {
  server: "http://localhost:8000",
  project: 2,
  default_profile: "main",
  profiles: { main: { agent_id: 1, key: "tfk_a", display_name: "Claude (main)" } },
};

describe("resolveProfileOrAsk", () => {
  it("resolves silently when the file defines exactly one profile", () => {
    const result = resolveProfileOrAsk(ONE_PROFILE, { env: {} });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.profile.profileName).toBe("main");
  });

  it("is ambiguous with several profiles and nothing to disambiguate", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {} });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.profiles.map((p) => p.name).sort()).toEqual(["bear", "main"]);
    }
  });

  it("is STILL ambiguous when default_profile is set — it only recommends", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {} });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.profiles.find((p) => p.name === "main")?.recommended).toBe(true);
      expect(result.profiles.find((p) => p.name === "bear")?.recommended).toBe(false);
    }
  });

  it("carries each profile's display name for the human's picker", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {} });
    if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(result.profiles.find((p) => p.name === "bear")?.display_name).toBe("Claude (bear)");
  });

  it("an explicit argument wins over ambiguity", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {}, profile: "bear" });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.profile.agentId).toBe(2);
  });

  it("TASKFLOW_PROFILE wins over ambiguity", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: { TASKFLOW_PROFILE: "bear" } });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.profile.profileName).toBe("bear");
  });

  it("a sticky pick wins over ambiguity", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {}, sticky: "bear" });
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.profile.profileName).toBe("bear");
  });

  it("TASKFLOW_PROFILE outranks a stale sticky pick", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, {
      env: { TASKFLOW_PROFILE: "main" },
      sticky: "bear",
    });
    if (result.kind !== "resolved") throw new Error("expected resolved");
    expect(result.profile.profileName).toBe("main");
  });

  it("falls back to asking when the sticky pick is no longer in the file", () => {
    const result = resolveProfileOrAsk(TWO_PROFILES, { env: {}, sticky: "deleted" });
    expect(result.kind).toBe("ambiguous");
  });

  it("still throws for an explicit profile that does not exist", () => {
    expect(() => resolveProfileOrAsk(TWO_PROFILES, { env: {}, profile: "nope" })).toThrow(
      /not defined/,
    );
  });
});
