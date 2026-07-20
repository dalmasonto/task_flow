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
import { execFileSync } from "node:child_process";
// Structure-preserving serializer: a JSON string sliced mid-token does not parse,
// so oversized payloads are shortened field-by-field instead. See metadata.mjs.
import { compactMetadata } from "./metadata.mjs";
import { hostname, tmpdir } from "node:os";

const REQUEST_TIMEOUT_MS = 2500;

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




/**
 * The tmux pane this Claude session runs in, or null.
 *
 * Mirrors detectTmuxPane() in src/tmux.ts: prefer $TMUX_PANE, else match an
 * ancestor's controlling tty against tmux's pane list. Kept inline because this
 * hook is deliberately dependency-free — it must run before anything is built.
 */
function detectTmuxPane() {
  const fromEnv = (process.env.TMUX_PANE || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const panes = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"], {
      encoding: "utf8",
      timeout: 3000,
    })
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .filter((parts) => parts.length === 2);
    let pid = process.ppid;
    for (let depth = 0; depth < 4 && pid > 1; depth += 1) {
      try {
        const tty = execFileSync("readlink", [`/proc/${pid}/fd/0`], {
          encoding: "utf8",
          timeout: 3000,
        }).trim();
        const hit = panes.find(([, paneTty]) => paneTty === tty);
        if (hit) return hit[0];
      } catch {
        /* try the next ancestor */
      }
      try {
        pid = Number(
          execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 3000,
          }).trim(),
        );
      } catch {
        break;
      }
    }
  } catch {
    /* no tmux */
  }
  return null;
}


/**
 * Report a pending AskUserQuestion so a human can answer it from the dashboard.
 *
 * Only the FIRST question is reported: the tool accepts several, but the agent's
 * terminal presents them one at a time, and answering a later one out of order
 * would send keys to the wrong screen.
 *
 * The payload goes into dedicated columns rather than metadata, so the options
 * are the record itself and cannot be shortened away by any budget.
 */
async function reportPrompt(profile, sessionId, toolInput) {
  const asked = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  // Every question must carry real options; one malformed entry would shift the
  // answers out of alignment with the questions they belong to.
  const usable = asked.filter(
    (q) => q && Array.isArray(q.options) && q.options.length >= 2,
  );
  if (!usable.length) return;

  const questions = usable.map((question) => ({
    question: String(question.question ?? question.header ?? "Agent is asking").slice(0, 2000),
    kind: question.multiSelect ? "multi" : "single",
    // Numbered to match what the terminal renders: option N is the key to press.
    options: question.options.map((option, index) => ({
      number: index + 1,
      label: String(option.label ?? "").slice(0, 200),
      description: String(option.description ?? "").slice(0, 500),
      // The preview is often the whole point of the question — a mockup, a diff,
      // a config block. Dropping it left the dashboard asking someone to choose
      // between things they could not see.
      ...(option.preview ? { preview: String(option.preview).slice(0, 4000) } : {}),
    })),
  }));

  const first = questions[0];
  await post(profile, `/api/taskflow/agents/sessions/${sessionId}/prompt`, {
    // The row's own columns describe the FIRST question, for list views and for
    // readers written before multi-question support.
    question: first.question,
    options_json: JSON.stringify(questions),
    kind: questions.length > 1 ? "set" : first.kind,
    // Identity of the whole SET, so a re-render or retry updates one row.
    fingerprint: usable
      .map((q) => `${q.header ?? ""}::${q.question ?? ""}`)
      .join("|")
      .slice(0, 300),
  });
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
  // Prefer the PANE as the session key so the hook, the MCP tools and the
  // terminal mirror all register the SAME session. Keying on Claude's session id
  // instead produced a second row per agent — the dashboard then showed several
  // "connected sessions" for one agent, and the terminal panel could pick the
  // one that never streams.
  const pane = detectTmuxPane();
  const sessionIdentifier = pane ? `tmux:${hostname()}:${pane}` : `claude:${claudeSessionId}`;

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

      // AskUserQuestion is the one tool whose PRE event matters: the agent is
      // about to block on a question, and that is precisely when a human needs
      // to see it. Its payload is also the reason the activity row alone is not
      // enough — options are truncated there, and the row only lands on Post,
      // by which time the question is already answered.
      if (toolName === "AskUserQuestion") {
        const sessionId = readSessionId(claudeSessionId);
        if (sessionId != null) {
          if (isPre) {
            await reportPrompt(profile, sessionId, event.tool_input || event.toolInput);
          } else {
            await post(profile, `/api/taskflow/agents/sessions/${sessionId}/prompt/clear`, {});
          }
        }
      }
      // Log ONCE per tool call, on completion. Logging both phases doubled every
      // row in the activity feed (a 50-tool session read as 100 events), and the
      // pre/post distinction lived only in metadata the UI never surfaces.
      // PreToolUse still heartbeats — that's what keeps the agent showing as
      // busy while a long tool runs.
      if (!isPre) {
        await post(profile, "/api/taskflow/agents/activity", {
          action: `tool:${toolName}`,
          body_markdown: "completed",
          // toolName selects which field (if any) may be shortened. Everything
          // else about the call is recorded in full.
          metadata_json: compactMetadata(
            { input: event.tool_input || event.toolInput },
            toolName,
          ),
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
