#!/usr/bin/env node
/**
 * TaskFlow Claude Code hook — a standalone Node script (no build step).
 *
 * Claude Code invokes it for lifecycle events, passing the event JSON on stdin.
 * The hook resolves `.taskflow.json` + a profile, maps the event to a TaskFlow
 * activity (and, for session lifecycle, a session register/heartbeat/close), and
 * POSTs it with the profile key.
 *
 * Contract: it MUST be fast and MUST NEVER block or crash the agent. Every
 * failure path swallows the error and exits 0; requests have a short timeout.
 *
 * Wire it in `.claude/settings.json` (see `.claude/settings.example.json`):
 *   SessionStart / PreToolUse / PostToolUse / Stop / Notification →
 *     node <abs path>/hooks/taskflow-hook.mjs
 *
 * Profile: reads `TASKFLOW_PROFILE` (else default_profile, else "main").
 * Config:  reads `TASKFLOW_CONFIG`, else walks up from `cwd` to `.taskflow.json`.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";

const REQUEST_TIMEOUT_MS = 2500;
const META_MAX_CHARS = 1500;

/** Never let this process take the agent down: log to stderr and exit 0. */
function bail(reason) {
  if (process.env.TASKFLOW_HOOK_DEBUG) {
    process.stderr.write(`taskflow-hook: ${reason}\n`);
  }
  process.exit(0);
}

// ---- config resolution (inlined so the hook needs no build/deps) ----

function findConfigPath(startDir) {
  const explicit = process.env.TASKFLOW_CONFIG;
  if (explicit) {
    const abs = resolve(explicit);
    return existsSync(abs) ? abs : null;
  }
  let dir = resolve(startDir || process.cwd());
  while (true) {
    const candidate = join(dir, ".taskflow.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadProfile(startDir) {
  const path = findConfigPath(startDir);
  if (!path) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const profiles = config.profiles || {};
  const name =
    (process.env.TASKFLOW_PROFILE && process.env.TASKFLOW_PROFILE.trim()) ||
    config.default_profile ||
    "main";
  const profile = profiles[name];
  if (!profile || !profile.key) return null;
  const server = String(config.server || "").replace(/\/+$/, "");
  if (!server) return null;
  return { server, key: profile.key, profileName: name };
}

// ---- tiny HTTP helper (best-effort, short timeout) ----

async function post(profile, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${profile.server}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Agent ${profile.key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- session id cache, keyed by the Claude session id ----

function stateFile(sessionKey) {
  const safe = String(sessionKey || "default").replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(tmpdir(), `taskflow-hook-${safe}.json`);
}

function readSessionId(sessionKey) {
  try {
    const raw = readFileSync(stateFile(sessionKey), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.sessionId === "number" ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

function writeSessionId(sessionKey, sessionId) {
  try {
    writeFileSync(stateFile(sessionKey), JSON.stringify({ sessionId }));
  } catch {
    /* ignore */
  }
}

// ---- stdin ----

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolvePromise(data);
      }
    };
    // Guard against a hook invoked with no piped stdin.
    const guard = setTimeout(done, 1000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(guard);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(guard);
      done();
    });
  });
}

/** Compact a tool input object into a short metadata JSON string. */
function compactMetadata(obj) {
  if (obj == null) return undefined;
  let text;
  try {
    text = JSON.stringify(obj);
  } catch {
    return undefined;
  }
  if (text.length > META_MAX_CHARS) {
    text = text.slice(0, META_MAX_CHARS) + "…";
  }
  return text;
}

async function main() {
  const stdin = await readStdin();
  let event = {};
  try {
    event = stdin ? JSON.parse(stdin) : {};
  } catch {
    // A malformed/absent payload is not worth crashing over.
    bail("unparseable stdin");
  }

  const startDir = event.cwd || process.cwd();
  const profile = loadProfile(startDir);
  if (!profile) bail("no usable .taskflow.json / profile");

  const eventName =
    event.hook_event_name || event.hookEventName || event.event || "unknown";
  const claudeSessionId = event.session_id || event.sessionId || `${hostname()}:${process.pid}`;
  const sessionIdentifier = `claude:${claudeSessionId}`;

  try {
    if (eventName === "SessionStart") {
      const session = await post(profile, "/api/taskflow/agents/sessions", {
        session_identifier: sessionIdentifier,
        host: hostname(),
        pid: process.pid,
        cwd: startDir,
        transport: "claude-code",
      });
      if (session && typeof session.id === "number") {
        writeSessionId(claudeSessionId, session.id);
        await post(profile, `/api/taskflow/agents/sessions/${session.id}/heartbeat`, {
          status: "busy",
        });
      }
      await post(profile, "/api/taskflow/agents/activity", {
        action: "session_start",
        metadata_json: compactMetadata({ source: event.source, cwd: startDir }),
      });
    } else if (eventName === "PreToolUse" || eventName === "PostToolUse") {
      const toolName = event.tool_name || event.toolName || "tool";
      const isPre = eventName === "PreToolUse";
      // Log ONCE per tool call, on completion. Logging both phases doubled every
      // row in the activity feed (a 50-tool session read as 100 events), and the
      // pre/post distinction lived only in metadata the UI never surfaces.
      // PreToolUse still heartbeats — that's what keeps the agent showing as
      // busy while a long tool runs.
      if (!isPre) {
        await post(profile, "/api/taskflow/agents/activity", {
          action: `tool:${toolName}`,
          body_markdown: "completed",
          metadata_json: compactMetadata({
            input: event.tool_input || event.toolInput,
          }),
        });
      }
      const sessionId = readSessionId(claudeSessionId);
      if (sessionId != null) {
        await post(profile, `/api/taskflow/agents/sessions/${sessionId}/heartbeat`, {
          status: "busy",
        });
      }
    } else if (eventName === "Stop" || eventName === "SubagentStop") {
      const sessionId = readSessionId(claudeSessionId);
      if (sessionId != null) {
        await post(profile, `/api/taskflow/agents/sessions/${sessionId}/close`, {});
      }
      await post(profile, "/api/taskflow/agents/activity", {
        action: "session_stop",
      });
    } else if (eventName === "Notification") {
      await post(profile, "/api/taskflow/agents/activity", {
        action: "notification",
        body_markdown: event.message || event.notification || undefined,
        metadata_json: compactMetadata({ message: event.message }),
      });
    }
    // Unknown events are ignored (still exit 0).
  } catch (err) {
    bail(`post error: ${err && err.message ? err.message : err}`);
  }

  process.exit(0);
}

main().catch((err) => bail(`fatal: ${err && err.message ? err.message : err}`));
