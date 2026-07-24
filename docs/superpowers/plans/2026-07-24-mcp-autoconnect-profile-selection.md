# MCP Autoconnect + Profile Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TaskFlow MCP server register its session and heartbeat automatically on startup — in or out of tmux — and make a human choose the identity when the repo defines more than one profile.

**Architecture:** Connection is currently a side effect of terminal mirroring, so `mirror.ts`'s "no tmux pane" early return skips session registration entirely. We split the concerns into four focused modules: `sessions-store.ts` (per-terminal sticky pick), `connect.ts` (register + heartbeat + retry, always), `runtime.ts` (event stream, pane delivery, mirror — extracted verbatim from `index.ts`), and a thinner `index.ts`. Profile ambiguity becomes a typed tool refusal (`profile_ambiguous`) that instructs the agent to ask its human, plus a `select_profile` tool.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node ≥18, vitest, zod, `@modelcontextprotocol/sdk`. All work is in `mcp/`. No backend or frontend changes.

**Spec:** `docs/superpowers/specs/2026-07-24-mcp-autoconnect-profile-selection-design.md`

## Global Constraints

- All paths below are relative to `/home/dalmas/E/projects/local_task_tracker/mcp` unless stated otherwise. Run all commands from that directory.
- Import specifiers use the `.js` extension even for `.ts` sources (ESM + `moduleResolution: node16`). `import { x } from "./config.js"`.
- Never write to stdout from the server path — stdout is the MCP stdio transport. Diagnostics go to `process.stderr`.
- Nothing in the connect/mirror path may throw into the MCP transport. A backend that is down degrades to "tools return errors, retries continue"; it never kills the tool server.
- Backoff matches `events.ts:128`: base 1000 ms, ceiling 30000 ms, `Math.round(ceiling / 2 + Math.random() * (ceiling / 2))`.
- Liveness window is 90 s and heartbeat interval is 30 s. These mirror the backend's `AGENT_HEARTBEAT_WINDOW_SECS` and the frontend's `AGENT_HEARTBEAT_WINDOW_MS` — a three-way contract. Do not change them.
- Test style follows `src/mirror.test.ts`: inject `sleep`, clients and `env` as options; never touch real `process.env`, real timers, real network or real `process.cwd()` in a unit test.
- Run tests with `npm test` (vitest, single run). Typecheck with `npm run typecheck`.
- A single-profile `.taskflow.json` must behave exactly as it does today: silent connect, no prompt.

---

### Task 1: Per-terminal sticky profile store

The human should be asked which identity a terminal is **once per terminal**, not once per MCP reconnect. This is the storage that makes the pick stick.

**Files:**
- Create: `src/sessions-store.ts`
- Test: `src/sessions-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `terminalKey(options: TerminalKeyOptions): string`
  - `readStickyProfile(options: StickyOptions): string | undefined`
  - `writeStickyProfile(profile: string, options: StickyOptions): void`
  - `interface TerminalKeyOptions { pane?: string | null; cwd?: string; ppid?: number }`
  - `interface StickyOptions extends TerminalKeyOptions { configPath: string; now?: number }`

- [ ] **Step 1: Write the failing test**

Create `src/sessions-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStickyProfile, terminalKey, writeStickyProfile } from "./sessions-store.js";

/** A throwaway repo root with a .taskflow.json in it; returns that config path. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "taskflow-sticky-"));
  const configPath = join(dir, ".taskflow.json");
  writeFileSync(configPath, "{}");
  return configPath;
}

describe("terminalKey", () => {
  it("uses the tmux pane when there is one", () => {
    expect(terminalKey({ pane: "%3", cwd: "/repo", ppid: 42 })).toBe("tmux:%3");
  });

  it("falls back to a hashed cwd plus the parent pid outside tmux", () => {
    const key = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    expect(key).toMatch(/^cwd:[0-9a-f]{6}:42$/);
  });

  it("gives the same cwd the same hash, and different cwds different hashes", () => {
    const a = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    const b = terminalKey({ pane: null, cwd: "/repo", ppid: 42 });
    const c = terminalKey({ pane: null, cwd: "/other", ppid: 42 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("sticky profile", () => {
  it("returns undefined when nothing has been chosen", () => {
    const configPath = tempRepo();
    expect(readStickyProfile({ configPath, pane: "%0" })).toBeUndefined();
  });

  it("round-trips a pick for the same terminal", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    expect(readStickyProfile({ configPath, pane: "%0" })).toBe("bear");
  });

  it("keeps picks for different terminals apart", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    writeStickyProfile("main", { configPath, pane: "%1" });
    expect(readStickyProfile({ configPath, pane: "%0" })).toBe("bear");
    expect(readStickyProfile({ configPath, pane: "%1" })).toBe("main");
  });

  it("writes the store next to the config file, not the cwd", () => {
    const configPath = tempRepo();
    writeStickyProfile("bear", { configPath, pane: "%0" });
    const stored = JSON.parse(
      readFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "utf8"),
    );
    expect(stored.terminals["tmux:%0"].profile).toBe("bear");
  });

  it("ignores a pick older than the 30-day retention window", () => {
    const configPath = tempRepo();
    const day = 24 * 60 * 60 * 1000;
    writeStickyProfile("bear", { configPath, pane: "%0", now: 1_000_000_000_000 });
    expect(
      readStickyProfile({ configPath, pane: "%0", now: 1_000_000_000_000 + 31 * day }),
    ).toBeUndefined();
  });

  it("prunes expired entries on write so the file cannot grow forever", () => {
    const configPath = tempRepo();
    const day = 24 * 60 * 60 * 1000;
    writeStickyProfile("old", { configPath, pane: "%9", now: 1_000_000_000_000 });
    writeStickyProfile("new", { configPath, pane: "%0", now: 1_000_000_000_000 + 31 * day });
    const stored = JSON.parse(
      readFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "utf8"),
    );
    expect(Object.keys(stored.terminals)).toEqual(["tmux:%0"]);
  });

  it("degrades to undefined on a corrupt store rather than throwing", () => {
    const configPath = tempRepo();
    mkdirSync(join(configPath, "..", ".taskflow"), { recursive: true });
    writeFileSync(join(configPath, "..", ".taskflow", "sessions.json"), "{ not json");
    expect(readStickyProfile({ configPath, pane: "%0" })).toBeUndefined();
  });

  it("never throws when the store cannot be written", () => {
    const configPath = tempRepo();
    const dir = join(configPath, "..", ".taskflow");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    expect(() => writeStickyProfile("bear", { configPath, pane: "%0" })).not.toThrow();
    chmodSync(dir, 0o700);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- sessions-store`
Expected: FAIL — `Failed to resolve import "./sessions-store.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/sessions-store.ts`:

```ts
/**
 * Remember which profile a given TERMINAL chose, so the human is asked once per
 * terminal rather than once per MCP reconnect.
 *
 * The store lives beside `.taskflow.json` (never in the cwd — an agent may be
 * launched from a subdirectory) in `.taskflow/sessions.json`, whose directory
 * is already fully gitignored.
 *
 * Every operation is best-effort. A read-only checkout or a corrupt file costs
 * stickiness — the human is asked again — and must never fail the connect.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** How long a remembered pick stays good. Bounds the file across pane churn. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TerminalKeyOptions {
  /** The tmux pane id, when running under tmux. */
  pane?: string | null;
  /** Working directory; only used outside tmux. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Parent pid — the MCP client. Only used outside tmux. Defaults to `process.ppid`. */
  ppid?: number;
}

export interface StickyOptions extends TerminalKeyOptions {
  /** Absolute path of the `.taskflow.json` this store belongs to. */
  configPath: string;
  /** Injected clock for tests. */
  now?: number;
}

interface StoreShape {
  terminals: Record<string, { profile: string; chosen_at: string }>;
}

/**
 * Identify THIS terminal.
 *
 * Mirrors `defaultSessionIdentifier`'s preference: a tmux pane is the most
 * stable handle there is. Outside tmux we fall back to the working directory
 * plus the PARENT pid — the MCP client (Claude Code), which lives as long as
 * the conversation does, unlike this server's own pid.
 */
export function terminalKey(options: TerminalKeyOptions = {}): string {
  if (options.pane) return `tmux:${options.pane}`;
  const cwd = options.cwd ?? process.cwd();
  const ppid = options.ppid ?? process.ppid;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 6);
  return `cwd:${hash}:${ppid}`;
}

function storePath(configPath: string): string {
  return join(dirname(configPath), ".taskflow", "sessions.json");
}

function readStore(configPath: string): StoreShape {
  try {
    const parsed: unknown = JSON.parse(readFileSync(storePath(configPath), "utf8"));
    const terminals = (parsed as StoreShape | null)?.terminals;
    if (terminals && typeof terminals === "object") return { terminals };
  } catch {
    // Missing or corrupt — an empty store is the right answer either way.
  }
  return { terminals: {} };
}

/** The profile this terminal chose last, or undefined if there is none/it expired. */
export function readStickyProfile(options: StickyOptions): string | undefined {
  const now = options.now ?? Date.now();
  const entry = readStore(options.configPath).terminals[terminalKey(options)];
  if (!entry) return undefined;
  const chosenAt = Date.parse(entry.chosen_at);
  if (Number.isNaN(chosenAt) || now - chosenAt > RETENTION_MS) return undefined;
  return entry.profile;
}

/** Remember this terminal's pick, pruning anything past the retention window. */
export function writeStickyProfile(profile: string, options: StickyOptions): void {
  const now = options.now ?? Date.now();
  try {
    const store = readStore(options.configPath);
    for (const [key, entry] of Object.entries(store.terminals)) {
      const chosenAt = Date.parse(entry.chosen_at);
      if (Number.isNaN(chosenAt) || now - chosenAt > RETENTION_MS) {
        delete store.terminals[key];
      }
    }
    store.terminals[terminalKey(options)] = {
      profile,
      chosen_at: new Date(now).toISOString(),
    };
    const path = storePath(options.configPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
  } catch {
    // Best-effort: losing stickiness is acceptable, failing the connect is not.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- sessions-store`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/sessions-store.ts src/sessions-store.test.ts
git commit -m "feat(mcp): remember a terminal's profile pick in .taskflow/sessions.json"
```

---

### Task 2: Ambiguous profile resolution

`chooseProfileName` silently collapses every case to a single name, so two terminals in one repo both become `main`. This adds a third outcome — *ambiguous* — without disturbing the existing throwing resolver that explicit callers rely on.

**Files:**
- Modify: `src/config.ts` (add to the end; do not change `resolveProfile` or `chooseProfileName`)
- Test: `src/config.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `terminalKey`/`readStickyProfile` are *not* used here — the caller passes an already-read `sticky` name, so this module stays filesystem-free and unit-testable.
- Produces:
  - `interface ProfileChoice { name: string; display_name: string; recommended: boolean; in_use?: boolean }`
  - `type ProfileResolution = { kind: "resolved"; profile: ResolvedProfile } | { kind: "ambiguous"; profiles: ProfileChoice[] }`
  - `function resolveProfileOrAsk(config: TaskflowConfig, options: AskProfileOptions): ProfileResolution`
  - `interface AskProfileOptions extends ResolveProfileOptions { sticky?: string | undefined }`

- [ ] **Step 1: Write the failing test**

Append to `src/config.test.ts`:

```ts
import { resolveProfileOrAsk } from "./config.js";

const TWO_PROFILES = {
  server: "http://localhost:8000",
  project: 2,
  default_profile: "main",
  profiles: {
    main: { agent_id: 1, key: "tfk_a", display_name: "Claude (main)" },
    bear: { agent_id: 2, key: "tfk_b", display_name: "Claude (bear)" },
  },
};

const ONE_PROFILE = {
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — `resolveProfileOrAsk is not a function` (or an import error).

- [ ] **Step 3: Write the implementation**

Append to `src/config.ts`:

```ts
/** One selectable identity, as offered to the human choosing among them. */
export interface ProfileChoice {
  name: string;
  display_name: string;
  /** True for the file's `default_profile` — a hint, never a decision. */
  recommended: boolean;
  /** Filled in by the caller from live session data; omitted if unknown. */
  in_use?: boolean;
}

export type ProfileResolution =
  | { kind: "resolved"; profile: ResolvedProfile }
  | { kind: "ambiguous"; profiles: ProfileChoice[] };

export interface AskProfileOptions extends ResolveProfileOptions {
  /** This terminal's remembered pick, if any (see `sessions-store.ts`). */
  sticky?: string | undefined;
}

/**
 * Resolve a profile, or report that a human has to choose.
 *
 * Ambiguous means: several profiles defined, and nothing said which one this
 * terminal is. `default_profile` deliberately does NOT settle it — `--mint`
 * adds profiles without moving it, so honouring it would mean the prompt never
 * fires and two terminals silently share one identity, which is the bug.
 *
 * `resolveProfile` keeps its throwing contract for callers that already have a
 * name (`--tmux --profile=x`, `--mint`, a per-tool `profile` argument).
 */
export function resolveProfileOrAsk(
  config: TaskflowConfig,
  options: AskProfileOptions = {},
): ProfileResolution {
  const env = options.env ?? process.env;
  const explicit = options.profile?.trim() || env.TASKFLOW_PROFILE?.trim();
  if (explicit) {
    // Unknown name is a real error, not an invitation to ask: the caller
    // asserted an identity and got it wrong.
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: explicit }) };
  }

  const names = Object.keys(config.profiles);
  // A stale sticky pick (profile since removed from the file) falls through to
  // asking rather than throwing — the human never typed that name today.
  const sticky = options.sticky?.trim();
  if (sticky && config.profiles[sticky]) {
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: sticky }) };
  }

  if (names.length === 1) {
    return { kind: "resolved", profile: resolveProfile(config, { ...options, profile: names[0] }) };
  }

  const recommended = config.default_profile ?? DEFAULT_PROFILE_NAME;
  return {
    kind: "ambiguous",
    profiles: names.map((name) => ({
      name,
      display_name: config.profiles[name]?.display_name ?? name,
      recommended: name === recommended,
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- config`
Expected: PASS — the 10 new tests plus every pre-existing `config` test still green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(mcp): report an ambiguous profile instead of silently picking main"
```

---

### Task 3: Profile-aware session identifiers

`defaultSessionIdentifier` keys a session on the tmux pane alone. The backend rejects a re-registration of an identifier owned by a *different* agent with **409 CONFLICT** (`backend/plugins/taskflow-agents/src/views.rs:1813`). Selecting `bear` in a pane where `main` already registered would therefore 409 — the new feature breaking on its own core path. Putting the profile in the identifier makes the two identities distinct sessions.

**Files:**
- Create: `src/session-identifier.ts`
- Test: `src/session-identifier.test.ts`
- Modify: `src/server.ts` (delete the local `defaultSessionIdentifier` at lines 31-40; import the new one)
- Modify: `src/index.ts` (line ~183, the `session_identifier: \`tmux:${hostname()}:${pane}\`` literal)

**Interfaces:**
- Consumes: nothing.
- Produces: `function sessionIdentifier(options: { pane?: string | null; profileName: string; host?: string; pid?: number }): string`

- [ ] **Step 1: Write the failing test**

Create `src/session-identifier.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- session-identifier`
Expected: FAIL — `Failed to resolve import "./session-identifier.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/session-identifier.ts`:

```ts
/**
 * The identifier that names THIS process's session to the backend.
 *
 * Prefers the tmux pane, so the tools' session and the terminal mirror converge
 * on one row instead of two (register is idempotent per identifier). Falls back
 * to host:pid outside tmux.
 *
 * The PROFILE is part of the identifier because the backend treats an
 * identifier as globally unique and returns 409 CONFLICT when the row it names
 * belongs to a different agent (`views.rs:1813`). A pane where `main` has
 * already registered would otherwise be unable to re-register as `bear`, so
 * switching identity in a terminal — the whole point of profile selection —
 * would fail. Distinct identifiers give each identity its own row; the
 * abandoned one goes stale on its own inside the 90s liveness window.
 */

import { hostname } from "node:os";

export interface SessionIdentifierOptions {
  /** The tmux pane id, when running under tmux. */
  pane?: string | null;
  /** The resolved profile name — part of the identity, not decoration. */
  profileName: string;
  host?: string;
  pid?: number;
}

export function sessionIdentifier(options: SessionIdentifierOptions): string {
  const host = options.host ?? hostname();
  const base = options.pane ? `tmux:${host}:${options.pane}` : `${host}:${options.pid ?? process.pid}`;
  return `${base}#${options.profileName}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- session-identifier`
Expected: PASS, 4 tests.

- [ ] **Step 5: Replace both call sites**

In `src/server.ts`, delete the whole `defaultSessionIdentifier` function (the doc comment at line 31 through the closing brace at line 40) and add to the imports:

```ts
import { sessionIdentifier } from "./session-identifier.js";
```

Then update the two call sites. At `ensureSession` (was line 118):

```ts
      session_identifier: sessionIdentifier({
        pane: await detectTmuxPane(),
        profileName,
      }),
```

At the second call site (was line 469), replace `defaultSessionIdentifier(await detectTmuxPane())` with:

```ts
            sessionIdentifier({ pane: await detectTmuxPane(), profileName: resolved.profileName }),
```

In `src/index.ts`, replace the inline literal:

```ts
      const session = await client.registerSession({
        session_identifier: `tmux:${hostname()}:${pane}`,
```

with:

```ts
      const session = await client.registerSession({
        session_identifier: sessionIdentifier({ pane, profileName: profile.profileName }),
```

and add `import { sessionIdentifier } from "./session-identifier.js";` to its imports.

- [ ] **Step 6: Verify the whole suite and types still pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS.

If `ensureSession`'s call site does not have `profileName` in scope, note that its signature already takes `profileName: string` as its second parameter (`server.ts:110-114`) — use it directly.

- [ ] **Step 7: Commit**

```bash
git add src/session-identifier.ts src/session-identifier.test.ts src/server.ts src/index.ts
git commit -m "fix(mcp): key sessions by profile so switching identity in a pane doesn't 409"
```

---

### Task 4: The connection lifecycle

The module that fixes the reported bug: register + heartbeat on startup, forever, with no tmux involved.

**Files:**
- Create: `src/connect.ts`
- Test: `src/connect.test.ts`

**Interfaces:**
- Consumes: `sessionIdentifier` (Task 3); `TaskflowClient`, `TaskflowApiError` from `./client.js`; `ResolvedProfile` from `./config.js`.
- Produces:
  - `type ConnectionState = "starting" | "active" | "retrying" | "needs_profile" | "stopped"`
  - `interface ConnectionStatus { state: ConnectionState; detail?: string; attempts: number; session?: number }`
  - `interface ConnectedContext { client: TaskflowClient; session: number; profile: ResolvedProfile; pane: string | null }`
  - `interface ConnectionHandle { stop: () => void; settled: Promise<void>; beat: () => Promise<void> }`
  - `function startConnection(options: ConnectOptions): ConnectionHandle`
  - `function getConnectionStatus(): ConnectionStatus`
  - `function setNeedsProfile(detail: string): void`
  - `function resetConnectionStatus(): void`

- [ ] **Step 1: Write the failing test**

Create `src/connect.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  getConnectionStatus,
  resetConnectionStatus,
  setNeedsProfile,
  startConnection,
} from "./connect.js";
import { TaskflowApiError } from "./client.js";
import type { ResolvedProfile } from "./config.js";

const PROFILE: ResolvedProfile = {
  server: "http://localhost:8000",
  project: 2,
  profileName: "main",
  agentId: 1,
  key: "tfk_test",
  displayName: "Claude (main)",
  configPath: "/repo/.taskflow.json",
};

/** A fake client recording calls; `registerSession` fails the first `failures` times. */
function fakeClient(options: { failures?: number; heartbeat?: () => Promise<unknown> } = {}) {
  let registerCalls = 0;
  const heartbeats: number[] = [];
  return {
    registerCalls: () => registerCalls,
    heartbeats,
    client: {
      registerSession: async () => {
        registerCalls += 1;
        if (registerCalls <= (options.failures ?? 0)) throw new Error("fetch failed");
        return { id: 77, session_identifier: "x", status: "connected" };
      },
      heartbeat: async (session: number) => {
        heartbeats.push(session);
        if (options.heartbeat) return options.heartbeat();
        return { id: session, session_identifier: "x", status: "connected" };
      },
    } as never,
  };
}

/** Records sleep durations without sleeping; stops the run after `budget` sleeps. */
function fakeSleep(budget = 50) {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
      if (delays.length > budget) throw new Error("sleep budget exhausted");
    },
  };
}

beforeEach(() => {
  resetConnectionStatus();
});

describe("startConnection", () => {
  it("registers a session with NO tmux pane — the reported bug", async () => {
    const fake = fakeClient();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep().sleep,
      heartbeatMs: 30_000,
    });
    await handle.settled;
    expect(fake.registerCalls()).toBe(1);
    expect(getConnectionStatus().state).toBe("active");
    expect(getConnectionStatus().session).toBe(77);
    handle.stop();
  });

  it("announces the live session once, with the pane it has (or does not have)", async () => {
    const fake = fakeClient();
    const seen: Array<{ session: number; pane: string | null }> = [];
    const handle = startConnection({
      profile: PROFILE,
      pane: "%0",
      createClient: () => fake.client,
      sleep: fakeSleep().sleep,
      onSession: (ctx) => {
        seen.push({ session: ctx.session, pane: ctx.pane });
      },
    });
    await handle.settled;
    expect(seen).toEqual([{ session: 77, pane: "%0" }]);
    handle.stop();
  });

  it("keeps retrying past the old 8-attempt give-up point", async () => {
    const fake = fakeClient({ failures: 12 });
    const sleeper = fakeSleep();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: sleeper.sleep,
    });
    await handle.settled;
    expect(fake.registerCalls()).toBe(13);
    expect(getConnectionStatus().state).toBe("active");
    handle.stop();
  });

  it("caps and jitters the backoff like the event stream does", async () => {
    const fake = fakeClient({ failures: 10 });
    const sleeper = fakeSleep();
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: sleeper.sleep,
    });
    await handle.settled;
    expect(sleeper.delays.length).toBe(10);
    expect(Math.min(...sleeper.delays)).toBeGreaterThanOrEqual(500);
    expect(Math.max(...sleeper.delays)).toBeLessThanOrEqual(30_000);
    handle.stop();
  });

  it("reports 'retrying' with the reason while the backend is down", async () => {
    const fake = fakeClient({ failures: 2 });
    const sleeper = fakeSleep();
    let sawRetrying = false;
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: async (ms) => {
        if (getConnectionStatus().state === "retrying") sawRetrying = true;
        return sleeper.sleep(ms);
      },
    });
    await handle.settled;
    expect(sawRetrying).toBe(true);
    handle.stop();
  });

  it("never rejects, even when registration fails forever", async () => {
    const fake = fakeClient({ failures: Number.MAX_SAFE_INTEGER });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(5).sleep,
    });
    await expect(handle.settled).resolves.toBeUndefined();
    handle.stop();
  });

  it("re-registers when a heartbeat says the session is gone (404)", async () => {
    let beats = 0;
    const fake = fakeClient({
      heartbeat: async () => {
        beats += 1;
        if (beats === 1) {
          throw new TaskflowApiError("POST", "/heartbeat", 404, "no such session");
        }
        return { id: 77, session_identifier: "x", status: "connected" };
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      // The background loop would race this test's explicit beat() and make
      // which call sees the 404 nondeterministic. Drive the tick by hand.
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(fake.registerCalls()).toBe(2);
    handle.stop();
  });

  it("does not re-register on a transient heartbeat failure", async () => {
    const fake = fakeClient({
      heartbeat: async () => {
        throw new Error("fetch failed");
      },
    });
    const handle = startConnection({
      profile: PROFILE,
      pane: null,
      createClient: () => fake.client,
      sleep: fakeSleep(3).sleep,
      autoHeartbeat: false,
    });
    await handle.settled;
    await handle.beat();
    expect(fake.registerCalls()).toBe(1);
    handle.stop();
  });
});

describe("needs_profile", () => {
  it("reports that it is deliberately not connecting", () => {
    setNeedsProfile("2 profiles defined; waiting for select_profile");
    expect(getConnectionStatus().state).toBe("needs_profile");
    expect(getConnectionStatus().detail).toMatch(/select_profile/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- connect`
Expected: FAIL — `Failed to resolve import "./connect.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/connect.ts`:

```ts
/**
 * The agent's connection to TaskFlow: register a session, prove liveness, and
 * keep doing both for as long as the process lives.
 *
 * ## Why this is its own module
 *
 * This ran as step one of `startMirrorForThisAgent`'s `start(pane)` callback,
 * behind `mirror.ts`'s "no tmux pane, nothing to mirror" early return. A
 * capability (presence) was smuggled inside a feature (terminal mirroring), so
 * the feature's precondition became the capability's: an agent outside tmux
 * never registered, never heartbeat, and never appeared in the dashboard.
 *
 * Mirroring is now layered on top of this — `onSession` hands the caller a live
 * session to attach the event stream and the pane mirror to.
 *
 * Retries are UNBOUNDED. The old startup gave up after 8 attempts (~2 minutes)
 * and stayed dead for the life of the process, which is indistinguishable from
 * the bug this module fixes: starting the MCP before the backend is a normal
 * ordering, not an error.
 */

import { TaskflowApiError, TaskflowClient } from "./client.js";
import type { ResolvedProfile } from "./config.js";
import { sessionIdentifier } from "./session-identifier.js";
import { hostname } from "node:os";

/** Backoff, matching `events.ts`'s reconnect policy exactly. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** 30s beats inside a 90s liveness window — a three-way contract with the
 *  backend's AGENT_HEARTBEAT_WINDOW_SECS and the frontend's ..._MS. */
const HEARTBEAT_MS = 30_000;

export type ConnectionState = "starting" | "active" | "retrying" | "needs_profile" | "stopped";

export interface ConnectionStatus {
  state: ConnectionState;
  /** Why, in the caller's words — always set for `retrying` and `needs_profile`. */
  detail?: string;
  attempts: number;
  /** The live session row id, once registered. */
  session?: number;
}

export interface ConnectedContext {
  client: TaskflowClient;
  session: number;
  profile: ResolvedProfile;
  pane: string | null;
}

export interface ConnectOptions {
  profile: ResolvedProfile;
  /** The tmux pane, or null outside tmux. Null is a normal, connectable state. */
  pane: string | null;
  /** Fired ONCE, on the first successful registration. */
  onSession?: (ctx: ConnectedContext) => void | Promise<void>;
  /** Test seam. */
  createClient?: (profile: ResolvedProfile) => TaskflowClient;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  heartbeatMs?: number;
  /** Test seam. False drives heartbeats by hand via `handle.beat()`, so a
   *  background tick cannot race an assertion. Always true in production. */
  autoHeartbeat?: boolean;
}

export interface ConnectionHandle {
  stop: () => void;
  /** Resolves when the initial registration settles. Tests await this. */
  settled: Promise<void>;
  /** Run one heartbeat tick now. Tests use it; production uses the loop. */
  beat: () => Promise<void>;
}

let status: ConnectionStatus = { state: "starting", attempts: 0 };

/** The current connection status, for `whoami` to report. */
export function getConnectionStatus(): ConnectionStatus {
  return { ...status };
}

/** Record that we are deliberately NOT connecting until a human picks. */
export function setNeedsProfile(detail: string): void {
  status = { state: "needs_profile", detail, attempts: 0 };
}

/** Test seam — reset module-level status between cases. */
export function resetConnectionStatus(): void {
  status = { state: "starting", attempts: 0 };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never hold the process open for a retry.
    (t as unknown as { unref?: () => void }).unref?.();
  });

/**
 * Connect and stay connected. Never throws and never rejects: the agent must
 * keep working whether or not the dashboard is reachable.
 */
export function startConnection(options: ConnectOptions): ConnectionHandle {
  const {
    profile,
    pane,
    log = () => {},
    sleep = defaultSleep,
    heartbeatMs = HEARTBEAT_MS,
    autoHeartbeat = true,
    createClient = (p: ResolvedProfile) => new TaskflowClient({ server: p.server, key: p.key }),
  } = options;

  const client = createClient(profile);
  const identifier = sessionIdentifier({ pane, profileName: profile.profileName });
  let stopped = false;
  let session: number | undefined;

  const register = async (): Promise<number> => {
    const row = await client.registerSession({
      session_identifier: identifier,
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      transport: pane ? "tmux" : "mcp",
    });
    return row.id;
  };

  /** One heartbeat tick. A dead session is re-registered; anything else waits. */
  const beat = async (): Promise<void> => {
    if (stopped || session === undefined) return;
    try {
      await client.heartbeat(session);
    } catch (err) {
      // 404: the row is gone (backend restarted with a fresh DB, or it was
      // swept). 401: the credential was rejected mid-flight. Both are fixed by
      // registering again — it is idempotent per identifier and re-adopts the
      // SAME row id, so the mirror's session number stays valid.
      const status_ = err instanceof TaskflowApiError ? err.status : 0;
      if (status_ === 404 || status_ === 401) {
        try {
          session = await register();
          status = { ...status, session };
          log(`session re-registered as ${session}`);
        } catch {
          // The next tick tries again; a backend mid-restart is expected.
        }
        return;
      }
      // Transient (network, 5xx): the next tick retries. Re-registering here
      // would hammer a struggling backend with writes instead of cheap beats.
      log(`heartbeat failed (${(err as Error).message.split("\n")[0]})`);
    }
  };

  const heartbeatLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await sleep(heartbeatMs);
      } catch {
        return; // test sleep budget exhausted, or the timer was torn down
      }
      await beat();
    }
  };

  const run = async (): Promise<void> => {
    for (let attempt = 1; !stopped; attempt += 1) {
      try {
        session = await register();
        status = { state: "active", attempts: attempt, session };
        if (attempt > 1) log(`connected after ${attempt} attempts`);
        await options.onSession?.({ client, session, profile, pane });
        if (autoHeartbeat) void heartbeatLoop();
        return;
      } catch (err) {
        const detail = (err as Error).message.split("\n")[0] ?? String(err);
        status = { state: "retrying", attempts: attempt, detail };
        // Grow, cap, jitter — so a backend coming back up is not hit by every
        // client at once.
        const ceiling = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
        log(`not connected yet (${detail}) — retrying in ${delay}ms`);
        try {
          await sleep(delay);
        } catch {
          return; // test sleep budget exhausted
        }
      }
    }
  };

  const settled = run();

  return {
    settled,
    beat,
    stop: () => {
      stopped = true;
      status = { ...status, state: "stopped" };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- connect`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/connect.ts src/connect.test.ts
git commit -m "feat(mcp): connect and heartbeat on startup, with or without tmux"
```

---

### Task 5: Extract the agent runtime from `index.ts`

A pure move, no behavior change, committed on its own so the next task's diff is readable. `index.ts` is 342 lines with 170 of them being an inline closure; `server.ts` will need to start the same runtime from `select_profile`, and importing `index.ts` would be circular.

**Files:**
- Create: `src/runtime.ts`
- Modify: `src/index.ts` (remove the `start:` callback body and its now-unused imports)

**Interfaces:**
- Consumes: `ConnectedContext` from `./connect.js` (Task 4).
- Produces: `function startAgentRuntime(ctx: ConnectedContext, log: (line: string) => void): void`

- [ ] **Step 1: Create the module by moving the existing code**

Create `src/runtime.ts` containing, verbatim from `index.ts`, the helper `messageSourceFor` (lines 153-159) and the entire body of the `start: async (pane) => {...}` callback (lines 177-334) — **minus** its first three statements (`loadProfile`, `new TaskflowClient`, `client.registerSession`), which `connect.ts` now owns.

```ts
/**
 * Everything that runs ONCE THERE IS A LIVE SESSION: the agent event stream
 * (message delivery, prompt replay, terminal keys) and the tmux pane mirror.
 *
 * Extracted from `index.ts` because two callers need it — the bin entry at
 * startup, and `select_profile` once a human has chosen an identity — and
 * because a 170-line closure inside a bin entry is not a unit anyone can
 * reason about.
 *
 * The pane is optional. Without one there is nothing to mirror and nowhere to
 * type a message, so only the parts that need a pane are skipped; the session
 * itself is already live and `check_messages` still works.
 */

import { hostname } from "node:os";
import type { ConnectedContext } from "./connect.js";
import type { TaskflowClient } from "./client.js";
import { formatIncoming, shouldDeliver, startAgentEventStream } from "./events.js";
import { notifyPane, sendKeySteps, sendKeyToPane, startMirrorLoop } from "./tmux.js";
import { createSerialQueue } from "./pane-queue.js";
import { stepsForPrompt } from "./prompts.js";
import { resolveMessage, type MessageSource, type ResolvedMessage } from "./resolve.js";

function messageSourceFor(client: TaskflowClient): MessageSource {
  return {
    listChannels: () => client.listChannels(),
    listMessages: (params) =>
      client.listMessages(params) as Promise<{ messages: ResolvedMessage[] }>,
  };
}

export function startAgentRuntime(ctx: ConnectedContext, log: (line: string) => void): void {
  const { client, session, profile, pane } = ctx;
  // ... move the paneQueue / deliverMessageById / catchUpUnread / event-stream
  // / startMirrorLoop code here unchanged, replacing `process.stderr.write(
  // `taskflow-v2-mcp: ...`)` with `log(...)` and `profile.agentId` as before.
}
```

Apply these substitutions while moving:
- `process.stderr.write(\`taskflow-v2-mcp: X\n\`)` → `log("X")`
- `session.id` → `session` (it is now a plain number)
- Guard the two pane-only paths: wrap the `startMirrorLoop({...})` call and the `notifyPane` inside `deliverMessageById` in `if (pane)`. When `pane` is null, `deliverMessageById` still resolves and marks read but does not type. Keep `onTerminalKey` and `onPromptAnswered` behind the same `if (pane)` guard — both call `sendKeys*`, which need a pane.
- `startMirrorLoop`'s `target: pane` needs a non-null pane, which the guard provides.

- [ ] **Step 2: Reduce `index.ts` to a call**

Replace the whole `startMirrorForThisAgent` function in `index.ts` with nothing for now (Task 6 rewires startup) and delete its now-unused imports (`notifyPane`, `sendKeySteps`, `sendKeyToPane`, `startMirrorLoop`, `startAgentEventStream`, `formatIncoming`, `shouldDeliver`, `createSerialQueue`, `stepsForPrompt`, `resolveMessage`, `startMirrorWithRetry`, `TaskflowClient`, `hostname`, `MessageSource`, `ResolvedMessage`). Leave `detectTmuxPane`, `runTmuxMirror`, `loadProfile`, `buildServer`, `ConfigError`, `runDoctor`, `runMint`.

Temporarily leave the `if (process.env.TASKFLOW_MIRROR !== "off")` block calling nothing — Task 6 fills it in. To keep this commit compiling and green, have it call `startAgentRuntime` via a minimal inline connect:

```ts
  if (process.env.TASKFLOW_MIRROR !== "off") {
    const profile = loadProfile();
    const pane = await detectTmuxPane().catch(() => null);
    startConnection({
      profile,
      pane,
      log: (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`),
      onSession: (ctx) =>
        startAgentRuntime(ctx, (line) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`)),
    });
  }
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; every existing test PASSES. `mirror.test.ts` still passes — `startMirrorWithRetry` is untouched and still used by `--tmux`.

- [ ] **Step 4: Commit**

```bash
git add src/runtime.ts src/index.ts
git commit -m "refactor(mcp): extract the agent runtime out of the bin entry"
```

---

### Task 6: Startup wiring — connect first, mirror second

**Files:**
- Modify: `src/index.ts` (the `main()` tail)

**Interfaces:**
- Consumes: `resolveProfileOrAsk` (Task 2), `readStickyProfile` (Task 1), `startConnection`/`setNeedsProfile` (Task 4), `startAgentRuntime` (Task 5).
- Produces, all from `src/runtime.ts`:
  - `function startAgent(options?: { configPath?: string }): Promise<void>` — the startup entry `index.ts` calls.
  - `function connectAs(profile: ResolvedProfile, pane: string | null): void`
  - `function selectProfile(profile: ResolvedProfile): Promise<void>` — persists the pick, then connects. This is what Task 7's `select_profile` tool calls.

- [ ] **Step 1: Add the shared entry to `runtime.ts`**

Append to `src/runtime.ts`:

```ts
import { findConfigPath, loadConfigFile, resolveProfileOrAsk, type ResolvedProfile } from "./config.js";
import { readStickyProfile, writeStickyProfile } from "./sessions-store.js";
import { setNeedsProfile, startConnection } from "./connect.js";
import { detectTmuxPane } from "./tmux.js";

const stderrLog = (line: string) => process.stderr.write(`taskflow-v2-mcp: ${line}\n`);

/**
 * Bring this agent online: resolve which identity this terminal is, then
 * connect and start the runtime. When the repo defines several identities and
 * nothing says which one this is, connect NOTHING and record `needs_profile` —
 * guessing would silently collapse two terminals into one agent.
 */
export async function startAgent(options: { configPath?: string } = {}): Promise<void> {
  const configPath = options.configPath ?? findConfigPath();
  const config = loadConfigFile(configPath);
  const pane = await detectTmuxPane().catch(() => null);
  const sticky = readStickyProfile({ configPath, pane });
  const resolution = resolveProfileOrAsk(config, { env: process.env, configPath, sticky });

  if (resolution.kind === "ambiguous") {
    const names = resolution.profiles.map((p) => p.name).join(", ");
    setNeedsProfile(`${resolution.profiles.length} profiles defined (${names}); waiting for select_profile`);
    stderrLog(`multiple identities (${names}) — the agent must ask its human, then call select_profile`);
    return;
  }
  connectAs(resolution.profile, pane);
}

/** Connect as a known profile and start the runtime. Used by `select_profile`. */
export function connectAs(profile: ResolvedProfile, pane: string | null): void {
  startConnection({
    profile,
    pane,
    log: stderrLog,
    onSession: (ctx) => startAgentRuntime(ctx, stderrLog),
  });
}

/** Persist a human's pick for this terminal, then connect as it. */
export async function selectProfile(profile: ResolvedProfile): Promise<void> {
  const pane = await detectTmuxPane().catch(() => null);
  writeStickyProfile(profile.profileName, { configPath: profile.configPath, pane });
  connectAs(profile, pane);
}
```

- [ ] **Step 2: Call it from `main()`**

In `src/index.ts`, replace the temporary block from Task 5 with:

```ts
  // Bring the agent online. This is NOT conditional on tmux: registering a
  // session is what makes the agent visible and reachable, and it must happen
  // whether or not there is a pane to mirror. Best-effort in every direction —
  // no credential, or a backend that is down, degrades to retrying quietly.
  void startAgent().catch((err) => {
    process.stderr.write(`taskflow-v2-mcp: could not start agent (${(err as Error).message})\n`);
  });
```

`TASKFLOW_MIRROR=off` now suppresses only the mirror, not the connection. Move that check into `startAgentRuntime`, guarding the `startMirrorLoop` call:

```ts
  if (pane && process.env.TASKFLOW_MIRROR !== "off") {
    startMirrorLoop({ /* ...unchanged... */ });
  }
```

Update the `--help` text in `index.ts` (`USAGE`, around line 60) accordingly:

```
TERMINAL MIRRORING IS AUTOMATIC. When the agent runs inside tmux, the server
finds its own pane and streams it to the dashboard — nothing to launch, no pane
id to look up. Set TASKFLOW_MIRROR=off to disable it. The agent still connects
and appears online without tmux; only the streamed terminal needs a pane.

WHICH IDENTITY AM I? With one profile in .taskflow.json the server connects as
it silently. With several, it connects as NONE of them and the agent must ask
you which this terminal is, then call select_profile — the pick is remembered
per terminal in .taskflow/sessions.json. Set TASKFLOW_PROFILE to skip the ask.
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/runtime.ts
git commit -m "feat(mcp): autoconnect on startup instead of only when mirroring"
```

---

### Task 7: `profile_ambiguous` refusals and the `select_profile` tool

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts` (create if absent)

**Interfaces:**
- Consumes: `resolveProfileOrAsk`, `ProfileChoice` (Task 2); `readStickyProfile` (Task 1); `selectProfile` (Task 6); `getConnectionStatus` (Task 4).
- Produces: the `select_profile` tool and a `profile_ambiguous` error body from every identity-requiring tool.

- [ ] **Step 1: Write the failing test**

Create `src/server.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ambiguityRefusal, markInUse } from "./server.js";
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
    const marked = markInUse(CHOICES, [
      { id: 1, display_name: "Claude (main)", identifier: "agent:2:x:main", status: "connected", last_seen_at: null },
    ], { main: 1, bear: 2 });
    expect(marked.find((p) => p.name === "main")?.in_use).toBe(true);
    expect(marked.find((p) => p.name === "bear")?.in_use).toBe(false);
  });

  it("omits in_use entirely when liveness could not be determined", () => {
    const marked = markInUse(CHOICES, null, { main: 1, bear: 2 });
    expect(marked.every((p) => p.in_use === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- server`
Expected: FAIL — `ambiguityRefusal` / `markInUse` are not exported.

- [ ] **Step 3: Add the helpers to `server.ts`**

Add near the other module-level helpers (after `fail`, around line 69):

```ts
/**
 * The refusal returned instead of guessing an identity.
 *
 * The server cannot prompt a human — MCP has no such primitive — but it can
 * return a machine-readable refusal naming the exact follow-up call that
 * resolves it. This is the typed-error equivalent for a protocol with no
 * interaction primitive.
 */
export function ambiguityRefusal(profiles: ProfileChoice[]): string {
  return JSON.stringify(
    {
      error: "profile_ambiguous",
      profiles,
      hint:
        "This repo defines several agent identities and nothing says which one this terminal is. " +
        "Ask your human which to use (show each display_name; 'recommended' is the file's default " +
        "and 'in_use' means another terminal is already that agent), then call " +
        "select_profile with their choice. Do NOT guess.",
    },
    null,
    2,
  );
}

/**
 * Annotate each choice with whether that agent already has a live session, so
 * the human can see which identity another terminal has taken.
 *
 * `agents` is null when liveness could not be determined; `in_use` is then
 * omitted rather than guessed — a picker with names only is still usable, but a
 * wrong `in_use` would send the human to the wrong terminal.
 */
export function markInUse(
  profiles: ProfileChoice[],
  agents: AgentSummary[] | null,
  agentIdByProfile: Record<string, number>,
): ProfileChoice[] {
  if (!agents) return profiles;
  const live = new Set(agents.filter((a) => a.status === "connected").map((a) => a.id));
  return profiles.map((p) => ({ ...p, in_use: live.has(agentIdByProfile[p.name] ?? -1) }));
}
```

Add the imports `ProfileChoice`, `resolveProfileOrAsk` from `./config.js` and `AgentSummary` from `./client.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- server`
Expected: PASS, 5 tests.

- [ ] **Step 5: Route every tool through the ambiguity check**

Replace `clientFor` (server.ts:105-108) with a version that returns either a client or a refusal:

```ts
  const paneOnce = detectTmuxPane().catch(() => null);

  /**
   * Resolve the identity for one tool call. Returns a refusal instead of a
   * client when a human still has to choose.
   */
  const clientFor = async (
    profile?: string,
  ): Promise<
    | { ok: true; resolved: ResolvedProfile; client: TaskflowClient }
    | { ok: false; refusal: CallToolResult }
  > => {
    const pane = await paneOnce;
    const sticky = readStickyProfile({ configPath, pane });
    const resolution = resolveProfileOrAsk(config, { profile, env, configPath, sticky });
    if (resolution.kind === "ambiguous") {
      // Liveness is a courtesy, never a blocker: any profile's credential can
      // read the project roster, since all profiles in a file share a project.
      const anyKey = Object.values(config.profiles)[0]?.key;
      let agents: AgentSummary[] | null = null;
      if (anyKey) {
        agents = await new TaskflowClient({ server: config.server, key: anyKey })
          .listAgents()
          .catch(() => null);
      }
      const byProfile = Object.fromEntries(
        Object.entries(config.profiles).map(([name, p]) => [name, p.agent_id]),
      );
      return {
        ok: false,
        refusal: {
          content: [{ type: "text", text: ambiguityRefusal(markInUse(resolution.profiles, agents, byProfile)) }],
          isError: true,
        },
      };
    }
    const resolved = resolution.profile;
    return {
      ok: true,
      resolved,
      client: new TaskflowClient({ server: resolved.server, key: resolved.key }),
    };
  };
```

Every existing tool handler currently opens with `const { client } = clientFor(profile);`. Change each to:

```ts
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
```

Apply this to every tool that calls `clientFor` (`whoami`, `list_tasks`, `list_channels`, `list_agents`, `create_task`, `update_task_status`, `claim_task`, `report_review`, `send_message`, `check_messages`, `mark_read`, `register_session`, `heartbeat`, `capture_terminal`, `log_activity`, `get_activity`, `download_attachment`). Grep to be sure none are missed:

```bash
grep -n "clientFor(" src/server.ts
```

- [ ] **Step 6: Report the connection status from `whoami`**

In the `whoami` handler, replace the return with:

```ts
        return ok({
          ...(identity as object),
          connection: getConnectionStatus(),
          mirror: getMirrorStatus(),
        });
```

Import `getConnectionStatus` from `./connect.js`. `connection: "active"` with `mirror: "off"` is the normal non-tmux state — the tool description should say so. Update it to:

```ts
    "Confirm which TaskFlow agent identity and project this credential maps to, plus the connection and terminal-mirror state. Connection and heartbeat are automatic — this confirms them, it does not establish them. mirror.state 'off' just means there is no tmux pane to stream; it is not an error.",
```

- [ ] **Step 7: Make `ensureSession` defer to `connect.ts`**

`ensureSession` (server.ts:110-127) registers its own session, which would now create a second row per process. Change it to prefer the one `connect.ts` holds:

```ts
  const ensureSession = async (client: TaskflowClient, profileName: string): Promise<number> => {
    // `connect.ts` registered one at startup; reuse it so this process owns ONE
    // session row rather than racing its own connection.
    const connected = getConnectionStatus().session;
    if (connected !== undefined) return connected;
    const existing = sessions.get(profileName);
    if (existing !== undefined) return existing;
    const session = await client.registerSession({
      session_identifier: sessionIdentifier({ pane: await paneOnce, profileName }),
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
      transport: "mcp",
    });
    sessions.set(profileName, session.id);
    return session.id;
  };
```

- [ ] **Step 8: Register the `select_profile` tool**

Add alongside `whoami`:

```ts
  server.tool(
    "select_profile",
    "Choose which agent identity this terminal is, when the repo defines several. Call this ONLY after asking your human which one to use — never guess. The choice is remembered for this terminal, so you will not be asked again after a reconnect.",
    { profile: z.string().describe("The profile name your human chose, e.g. 'main' or 'bear'.") },
    async ({ profile }) => {
      try {
        // Throws with the available names if this one is not in the file.
        const resolved = resolveProfile(config, { profile, env, configPath });
        await selectProfile(resolved);
        return ok({
          selected: resolved.profileName,
          display_name: resolved.displayName,
          agent_id: resolved.agentId,
          project: resolved.project,
          connection: getConnectionStatus(),
          note: "Connected. This terminal will use this identity from now on.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
```

Import `selectProfile` from `./runtime.js` and keep `resolveProfile` imported from `./config.js`.

- [ ] **Step 9: YOUR CONTRIBUTION — the in-use collision policy**

See the request below this task. Implement the marked function in `src/server.ts`.

- [ ] **Step 10: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests PASS.

- [ ] **Step 11: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat(mcp): refuse to guess an identity, and add select_profile"
```

---

### Task 8: Rewrite the agent instructions

`instructions.ts` teaches the model to do work the server now owns, and says nothing about ambiguity. Both are now wrong.

**Files:**
- Modify: `src/instructions.ts` (the "Identity & connecting" section)
- Test: `src/instructions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — `AGENT_INSTRUCTIONS` keeps its name and type.

- [ ] **Step 1: Write the failing test**

Append to `src/instructions.test.ts`:

```ts
describe("identity instructions", () => {
  it("no longer tells the agent to register a session by hand", () => {
    // Connection is automatic now; teaching the ritual makes the model do work
    // the server owns, and go stale when it forgets to repeat it.
    expect(AGENT_INSTRUCTIONS).not.toMatch(/then \*\*register_session\*\* and \*\*heartbeat\*\*/);
    expect(AGENT_INSTRUCTIONS).not.toMatch(/Send \*\*heartbeat\*\* periodically/);
  });

  it("says connection and presence are automatic", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/automatic/i);
  });

  it("documents the profile_ambiguous protocol", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/profile_ambiguous/);
    expect(AGENT_INSTRUCTIONS).toMatch(/select_profile/);
  });

  it("forbids guessing an identity", () => {
    expect(AGENT_INSTRUCTIONS).toMatch(/never guess/i);
  });

  it("mentions every tool it names", () => {
    for (const tool of ["whoami", "select_profile", "list_agents", "list_channels"]) {
      expect(AGENT_INSTRUCTIONS).toContain(tool);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- instructions`
Expected: FAIL on the `register_session` and `profile_ambiguous` assertions.

- [ ] **Step 3: Rewrite the section**

In `src/instructions.ts`, replace the `## Identity & connecting` section with:

```
## Identity & connecting
- One credential maps to **one agent identity in one project**. The optional
  \`profile\` argument on every tool selects which identity to act as (use the
  \`reviewer\` profile for review work).
- **Connecting is automatic.** The server registers your session and keeps
  heartbeating on its own — you do not need to call \`register_session\` or
  \`heartbeat\` to appear online. Call **whoami** to CONFIRM your identity,
  project, connection and terminal mirror. A \`mirror.state\` of \`off\` only
  means there is no tmux pane to stream; you are still connected.
- **If a tool returns \`profile_ambiguous\`**, this repo defines several
  identities and nothing says which one this terminal is. Ask your human which
  to use — show each \`display_name\`, note which is \`recommended\`, and warn
  that an \`in_use\` one is already taken by another terminal — then call
  **select_profile** with their answer. **Never guess a profile**: picking wrong
  makes two terminals the same agent, sharing one inbox and one read cursor.
  You are asked once per terminal; the choice is remembered across reconnects.
- Call **list_agents** to see who else is on the project and **list_channels** for
  the rooms you can post in. If other agents are active, coordinate rather than
  duplicate work.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- instructions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/instructions.ts src/instructions.test.ts
git commit -m "docs(mcp): drop the manual connect ritual, document profile_ambiguous"
```

---

### Task 9: Build, install and verify against a real backend

Every bug this plan fixes is cold-start behavior that unit tests structurally cannot catch — the lesson from the last dogfood round, where five defects survived a green suite. This task is not optional.

**Files:** none modified.

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, all tests PASS, `dist/` rebuilt. Record the actual test count.

- [ ] **Step 2: `--check` against a running backend**

The MCP is globally symlinked to this repo, so `npm run build` is the deploy.

```bash
cd /home/dalmas/E/projects/local_task_tracker && taskflow-v2-mcp --check
```
Expected: exit 0, reporting the resolved identity and a reachable backend.

- [ ] **Step 3: Verify it connects OUTSIDE tmux (the reported bug)**

In a plain terminal with no `TMUX` set:

```bash
env -u TMUX taskflow-v2-mcp 2>&1 | head -5
```
Expected stderr within a second or two: `connected (stdio)` and no `not running inside tmux` giving up. Confirm in the dashboard that the agent shows **online** with a green dot. Ctrl-C to stop.

- [ ] **Step 4: Verify it survives a cold backend**

Stop the backend, start the MCP, wait past the old 8-attempt window (~3 minutes), then start the backend.

Expected: the agent comes online **without** restarting the MCP. Under the old code it would be permanently dead by then.

- [ ] **Step 5: Verify the profile prompt end-to-end**

```bash
taskflow-v2-mcp --mint bear --display-name "Claude (bear)" --token "$TASKFLOW_USER_TOKEN"
```

Then reconnect the MCP and, as the agent, call `whoami`.

Expected: a `profile_ambiguous` body listing `main` (recommended, `in_use: true` if another terminal holds it) and `bear`. Ask the human, call `select_profile({profile: "bear"})`, confirm it connects as agent `bear` and appears as a **separate** agent in the dashboard.

- [ ] **Step 6: Verify stickiness**

Reconnect the MCP in the same pane. Expected: **no** second prompt; `whoami` reports `bear` directly. Confirm `.taskflow/sessions.json` contains the pane key.

- [ ] **Step 7: Verify a single-profile repo is unchanged**

In a repo whose `.taskflow.json` has one profile, reconnect. Expected: silent connect, no prompt, agent online — identical to today.

- [ ] **Step 8: Commit any fixes and update the memory note**

```bash
git add -A src/ && git commit -m "fix(mcp): <whatever the live run turned up>"
```

Update `agent-identity-rework.md` in the memory directory with the outcome, and correct the `taskflow-mcp-reconnect` memory — "MCP doesn't reconnect after a backend restart; re-run whoami → register_session → heartbeat" is no longer true once Task 4 lands.

---

## Notes for the implementer

- **Do not "fix" `mirror.ts`'s 8-attempt limit.** It still governs `--tmux`, a foreground command a human is watching, where giving up is correct. Only the startup path moved to unbounded retry.
- **`resolveProfile` keeps throwing.** Explicit callers asserted an identity; a wrong name is their error, not an invitation to ask.
- **Never let `in_use` block anything by accident.** It is advisory. If `list_agents` fails, the field is omitted and the flow continues.
