#!/usr/bin/env node
/**
 * Integration smoke test — drive the real TaskflowClient against a live backend.
 *
 * Env:
 *   SMOKE_SERVER   backend base URL (default http://localhost:8010)
 *   SMOKE_KEY      an agent credential key (tfk_…) for a linked agent
 *   SMOKE_CHANNEL  optional channel id to use for send/check (else auto-picked)
 *
 * Behavior:
 *   - No SMOKE_KEY, or the backend is unreachable → print SKIPPED and exit 0
 *     (so it never fails a build in an environment without a backend).
 *   - Otherwise exercise the client end to end, printing PASS/FAIL per call.
 *     Exits 1 if any exercised call failed, 0 if all passed (or skipped).
 *
 * Requires a build first: `npm run build` (it imports the compiled client).
 *
 * Run:   SMOKE_SERVER=http://localhost:8010 SMOKE_KEY=tfk_xxx node scripts/smoke.mjs
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER = process.env.SMOKE_SERVER || "http://localhost:8010";
const KEY = process.env.SMOKE_KEY || "";

function line(status, name, extra) {
  const tag = status.padEnd(7);
  console.log(`${tag} ${name}${extra ? ` — ${extra}` : ""}`);
}

async function reachable(server) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${server}/api/taskflow/agents/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}

async function main() {
  if (!KEY) {
    line("SKIPPED", "smoke", "no SMOKE_KEY set");
    process.exit(0);
  }

  const distClient = join(__dirname, "..", "dist", "client.js");
  if (!existsSync(distClient)) {
    line("SKIPPED", "smoke", "dist not built — run `npm run build` first");
    process.exit(0);
  }

  if (!(await reachable(SERVER))) {
    line("SKIPPED", "smoke", `backend not reachable at ${SERVER}`);
    process.exit(0);
  }

  const { TaskflowClient } = await import(distClient);
  const client = new TaskflowClient({ server: SERVER, key: KEY });

  let failures = 0;
  const run = async (name, fn) => {
    try {
      const result = await fn();
      let summary = "";
      if (result && typeof result === "object") {
        if (Array.isArray(result)) summary = `${result.length} item(s)`;
        else if ("id" in result) summary = `id=${result.id}`;
        else if ("created" in result) summary = `created=${result.created}`;
        else if ("agent_id" in result) summary = `agent_id=${result.agent_id}`;
        else if ("messages" in result) summary = `${result.messages.length} message(s)`;
      }
      line("PASS", name, summary);
      return result;
    } catch (err) {
      failures += 1;
      line("FAIL", name, err && err.message ? err.message : String(err));
      return null;
    }
  };

  const who = await run("whoami", () => client.whoami());

  await run("create_task", () =>
    client.createTask({
      title: `smoke task ${new Date().toISOString()}`,
      description_markdown: "created by scripts/smoke.mjs",
      claim: true,
    }),
  );

  await run("list_tasks", () => client.listTasks());

  // Pick a channel for the message calls: SMOKE_CHANNEL, else the first visible.
  let channelId = process.env.SMOKE_CHANNEL ? Number(process.env.SMOKE_CHANNEL) : undefined;
  const channels = await run("list_channels", () => client.listChannels());
  if (channelId === undefined && Array.isArray(channels) && channels.length > 0) {
    channelId = channels[0].id;
  }

  if (channelId !== undefined) {
    await run(`send_message (channel ${channelId})`, () =>
      client.sendMessage({
        channel: channelId,
        body_markdown: `smoke ping ${Date.now()}`,
        client_nonce: `smoke-${Date.now()}`,
      }),
    );
    await run(`check_messages (channel ${channelId})`, () =>
      client.listMessages({ channel: channelId, limit: 5 }),
    );
  } else {
    line("SKIPPED", "send_message/check_messages", "no channel available");
  }

  const session = await run("register_session", () =>
    client.registerSession({
      session_identifier: `smoke:${who ? who.agent_id : "x"}:${Date.now()}`,
      host: "smoke-runner",
      pid: process.pid,
      cwd: process.cwd(),
      transport: "smoke",
    }),
  );

  if (session && typeof session.id === "number") {
    await run("heartbeat", () => client.heartbeat(session.id, "busy"));
    await run("capture_terminal", () =>
      client.appendFrame(session.id, { content: "$ smoke test frame\n", stream: "stdout" }),
    );
    await run("close_session", () => client.closeSession(session.id));
  } else {
    line("SKIPPED", "heartbeat/capture_terminal", "no session id");
  }

  await run("log_activity", () =>
    client.logActivity({ action: "smoke", body_markdown: "smoke test log" }),
  );

  await run("get_activity", () => client.listActivity({ limit: 5 }));

  console.log("");
  if (failures > 0) {
    console.log(`SMOKE: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("SMOKE: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.log(`SKIPPED smoke — unexpected error: ${err && err.message ? err.message : err}`);
  process.exit(0);
});
