/**
 * The TaskFlow MCP server (stdio transport).
 *
 * Loads `.taskflow.json` once, then registers one tool per meaningful agent
 * operation. Each tool validates its arguments with zod, resolves a profile
 * (per-call `profile` arg > `TASKFLOW_PROFILE` > `default_profile` > `main`),
 * builds a {@link TaskflowClient} for that profile, calls the backend, and
 * returns a concise text/JSON result. Errors are returned as tool errors
 * (`isError: true`) with the backend's detail — never thrown out of the tool.
 */

import { hostname } from "node:os";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  loadConfigFile,
  findConfigPath,
  resolveProfile,
  resolveProfileOrAsk,
  type ProfileChoice,
  type ResolvedProfile,
  type TaskflowConfig,
} from "./config.js";
import { TaskflowClient, TaskflowApiError, type AgentSummary } from "./client.js";
import { resolveAttachments } from "./attachments.js";
import { getMirrorStatus } from "./mirror.js";
import { downloadAttachment } from "./attachment-download.js";
import { detectTmuxPane } from "./tmux.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { sessionIdentifier } from "./session-identifier.js";
import { getConnectionStatus } from "./connect.js";
import { selectProfile } from "./runtime.js";
import { readStickyProfile } from "./sessions-store.js";

/**
 * The nudge attached to every check_messages result. A read cursor only advances
 * when the agent says so, so the instruction has to travel WITH the messages —
 * a model that reads them and moves on would be handed the same ones forever.
 */
function markReadReminder(count: number): string {
  return count > 0
    ? "You have unread messages above. When you have acted on them, call mark_read(channel, last_read_message=<highest id you handled>) so they stop being redelivered."
    : "Nothing unread.";
}

/** Wrap a value as a successful text tool result (JSON-pretty for objects). */
function ok(value: unknown): CallToolResult {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

/** Wrap an error as a tool error result carrying the backend detail. */
function fail(err: unknown): CallToolResult {
  const message =
    err instanceof TaskflowApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

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
 * The statuses a LIVE agent can report.
 *
 * The backend hands back a live agent's STORED status — `connected`, `idle` or
 * `busy` (`effective_agent_status` in taskflow-agents' views.rs) — and only
 * rewrites it to `offline` once the liveness window has lapsed. Testing for
 * `connected` alone therefore read an actively-working terminal (which the
 * instructions tell agents to report as `busy`) as FREE, and it self-healed
 * within one heartbeat, making it an intermittent false negative.
 *
 * An allow-list, not `!offline`: `blocked` / `revoked` are administrative
 * states that must not read as live, and neither should a status this build
 * has never heard of.
 */
const LIVE_AGENT_STATUSES = new Set(["connected", "idle", "busy"]);

/** Whether a roster row describes an agent that is live right now. */
export function isLiveAgentStatus(status: string): boolean {
  return LIVE_AGENT_STATUSES.has(status);
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
  const live = new Set(agents.filter((a) => isLiveAgentStatus(a.status)).map((a) => a.id));
  return profiles.map((p) => ({ ...p, in_use: live.has(agentIdByProfile[p.name] ?? -1) }));
}

/**
 * The warning returned when a human picks an identity another terminal already
 * holds.
 *
 * Deliberately NOT a refusal. A crashed terminal's session still looks live for
 * the rest of the 90s window, so refusing would lock someone out of their own
 * identity at the worst possible moment. The collision is real but recoverable;
 * being unable to reconnect is neither.
 *
 * Returns undefined when there is nothing to warn about, so the caller can
 * spread it into the result and have the field simply not appear.
 */
export function collisionWarning(
  profileName: string,
  live: AgentSummary | null,
): string | undefined {
  if (!live) return undefined;
  const seen = live.last_seen_at ? ` (last seen ${live.last_seen_at})` : "";
  return (
    `'${profileName}' already has a live session${seen}. Two terminals sharing one ` +
    `identity share one inbox and one read cursor, so messages meant for one will ` +
    `be marked read by the other. Tell your human before you continue.`
  );
}

export interface BuildServerOptions {
  configPath?: string;
  startDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Construct the MCP server with all tools registered. The config is loaded
 * eagerly so a broken `.taskflow.json` fails fast at startup with a clear error.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const configPath = findConfigPath({
    configPath: options.configPath,
    startDir: options.startDir,
    env: options.env,
  });
  const config: TaskflowConfig = loadConfigFile(configPath);
  const env = options.env ?? process.env;

  // Per-profile registered session id, so `heartbeat` / `capture_terminal`
  // don't need the caller to thread a session id through every call.
  const sessions = new Map<string, number>();

  const server = new McpServer(
    {
      name: "taskflow-v2-mcp",
      version: "0.1.0",
    },
    // Surfaced in the `initialize` result so the client shows the model how to
    // use these tools on connect — the workflow and conventions the per-tool
    // schemas can't convey (e.g. attach files, don't paste them inline).
    { instructions: AGENT_INSTRUCTIONS },
  );

  const paneOnce = detectTmuxPane().catch(() => null);

  /**
   * The project roster, fetched once for the life of the ambiguity.
   *
   * While a human has not picked, EVERY tool call is refused — and each refusal
   * annotates the choices with liveness, which is a network round-trip against
   * a 15s client timeout. Paying it per call, for as long as the ambiguity
   * lasts, buys nothing: the answer cannot change without someone picking a
   * profile, and picking one clears this cache.
   *
   * A FAILED fetch is not cached (the promise is dropped), so a backend that
   * comes up later still gets asked.
   */
  let roster: Promise<AgentSummary[] | null> | undefined;
  const rosterForAmbiguity = (): Promise<AgentSummary[] | null> => {
    // Liveness is a courtesy, never a blocker: any profile's credential can
    // read the project roster, since all profiles in a file share a project.
    const anyKey = Object.values(config.profiles)[0]?.key;
    if (!anyKey) return Promise.resolve(null);
    return (roster ??= new TaskflowClient({ server: config.server, key: anyKey })
      .listAgents()
      .catch(() => {
        roster = undefined;
        return null;
      }));
  };

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
      const agents = await rosterForAmbiguity();
      const byProfile = Object.fromEntries(
        Object.entries(config.profiles).map(([name, p]) => [name, p.agent_id]),
      );
      return {
        ok: false,
        refusal: {
          content: [
            {
              type: "text",
              text: ambiguityRefusal(markInUse(resolution.profiles, agents, byProfile)),
            },
          ],
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

  /** Ensure a live session exists for a profile; register one if not. */
  const ensureSession = async (
    client: TaskflowClient,
    profileName: string,
  ): Promise<number> => {
    // `connect.ts` registered one at startup; reuse it so this process owns ONE
    // session row rather than racing its own connection — but ONLY when it is
    // this profile's. The connection belongs to one identity; handing its
    // session id to a call made as a different `profile:` sends another agent's
    // session under this credential, and the backend's `load_owned_session`
    // 403s it.
    const connection = getConnectionStatus();
    if (connection.session !== undefined && connection.profile === profileName) {
      return connection.session;
    }
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

  const profileArg = {
    // Deliberately NOT `.min(1)` here, unlike `select_profile`: some clients
    // send "" for an omitted optional string, and `resolveProfileOrAsk` already
    // treats an empty value as ABSENT — which falls through to the per-terminal
    // resolution and, when that is ambiguous, to the refusal. There is no
    // silent guess on this path to protect against, only a needless hard error.
    profile: z
      .string()
      .optional()
      .describe(
        "Which agent identity to act as. Normally omit it: the identity is resolved per terminal " +
          "(TASKFLOW_PROFILE, this terminal's remembered pick, or the only profile in the file). " +
          "In a repo with several identities and nothing saying which this terminal is, omitting it " +
          "returns error 'profile_ambiguous' — ask your human, then call select_profile.",
      ),
  };

  // ---- identity / discovery ----

  server.tool(
    "whoami",
    "Confirm which TaskFlow agent identity and project this credential maps to, plus the connection and terminal-mirror state. Connection and heartbeat are automatic — this confirms them, it does not establish them. mirror.state 'off' just means there is no tmux pane to stream; it is not an error.",
    { ...profileArg },
    async ({ profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const identity = await client.whoami();
        // The mirror's health rides along with identity because a dead mirror
        // is otherwise invisible: it only ever wrote one line to stderr, which
        // nobody reads, so "the dashboard terminal is stale" could only be
        // answered by inspecting /proc and open sockets.
        return ok({
          ...(identity as object),
          connection: getConnectionStatus(),
          mirror: getMirrorStatus(),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "select_profile",
    "Choose which agent identity this terminal is, when the repo defines several. Call this ONLY after asking your human which one to use — never guess. The choice is remembered for this terminal, so you will not be asked again after a reconnect.",
    {
      // `.trim().min(1)`: `chooseProfileName` treats an empty string as ABSENT
      // and falls back to `default_profile ?? "main"`, so `profile: ""` (or,
      // without the trim, whitespace like "   ") would silently select and
      // stickie the default identity — the exact silent guess this tool
      // exists to remove. zod trims before the length check, so the trimmed
      // value is what reaches the handler.
      profile: z
        .string()
        .trim()
        .min(1)
        .describe("The profile name your human chose, e.g. 'main' or 'bear'."),
    },
    async ({ profile }) => {
      try {
        // Throws with the available names if this one is not in the file.
        const resolved = resolveProfile(config, { profile, env, configPath });

        // BEFORE connecting, not after: `selectProfile` registers a session for
        // this very agent, so a lookup afterwards would find OUR OWN row and
        // warn about a collision with ourselves on every single call.
        const live = await new TaskflowClient({ server: resolved.server, key: resolved.key })
          .listAgents()
          .then(
            (agents) =>
              agents.find((a) => a.id === resolved.agentId && isLiveAgentStatus(a.status)) ?? null,
          )
          .catch(() => null);

        await selectProfile(resolved);
        // The pick is made, so the ambiguity is over: drop the cached roster
        // rather than let a stale one outlive what it was fetched for.
        roster = undefined;

        const warning = collisionWarning(resolved.profileName, live);
        const connection = getConnectionStatus();
        return ok({
          selected: resolved.profileName,
          display_name: resolved.displayName,
          agent_id: resolved.agentId,
          project: resolved.project,
          connection,
          ...(warning ? { warning } : {}),
          // Reports what the connection actually is. `selectProfile` starts the
          // connection without awaiting it — deliberately, since `settled`
          // stays pending for as long as the backend is down — so an
          // unconditional "Connected." asserted a success nothing observed,
          // sitting right beside a `connection.state` of `starting` or a
          // `retrying` that may never end.
          note:
            connection.state === "active"
              ? "Connected. This terminal will use this identity from now on."
              : `Selected; the connection is ${connection.state}${
                  connection.detail ? ` (${connection.detail})` : ""
                }. This terminal will use this identity from now on — call whoami to check the connection.`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_tasks",
    "List tasks in the agent's project. Optional filters: status (e.g. not_started, in_progress, partial_done, done) and assigned='me' for tasks this agent has claimed.",
    {
      status: z.string().optional().describe("Filter by task status string."),
      assigned: z.string().optional().describe("'me' to show only tasks claimed by this agent."),
      ...profileArg,
    },
    async ({ status, assigned, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.listTasks({ status, assigned }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_channels",
    "List the chat channels this agent can see in its project (shared rooms plus any DMs it is on the roster of).",
    { ...profileArg },
    async ({ profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.listChannels());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_agents",
    "List the other agents in this project so you know who to address.",
    { ...profileArg },
    async ({ profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.listAgents());
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- tasks ----

  server.tool(
    "create_task",
    "Create a task in the agent's project. Optionally self-claim it. Returns the created task.",
    {
      title: z.string().min(1).describe("Short task title."),
      description: z.string().optional().describe("Markdown description."),
      priority: z
        .enum(["low", "normal", "high", "critical"])
        .optional()
        .describe("Task priority (default: normal)."),
      claim: z.boolean().optional().describe("If true, assign the new task to this agent."),
      ...profileArg,
    },
    async ({ title, description, priority, claim, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.createTask({
            title,
            description_markdown: description,
            priority,
            claim,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "update_task_status",
    "Advance a task's status (e.g. to partial_done to request review, or in_progress). Returns the updated task.",
    {
      task: z.number().int().describe("Task id."),
      // An enum, not a free string: the backend rejects anything outside this set
      // with a 422 the agent only discovers at call time. Plausible-sounding
      // guesses ("in_review", "todo") are exactly what a model reaches for, so
      // the valid set belongs in the schema where it can't be guessed wrong.
      status: z
        .enum([
          "not_started",
          "in_progress",
          "paused",
          "blocked",
          "partial_done",
          "done",
          "archived",
        ])
        .describe("New status. Use partial_done to request review."),
      ...profileArg,
    },
    async ({ task, status, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.updateTaskStatus(task, status));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "claim_task",
    "Self-assign a task in this agent's project. Returns the updated task.",
    { task: z.number().int().describe("Task id."), ...profileArg },
    async ({ task, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.claimTask(task));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "report_review",
    "Record a review verdict on a task (decision: approved | changes_requested). Reports back to the assigned agent and transitions the task. Consider the 'reviewer' profile for review work.",
    {
      task: z.number().int().describe("Task id under review."),
      decision: z.enum(["approved", "changes_requested"]).describe("The review verdict."),
      body: z.string().optional().describe("Optional review note (markdown)."),
      ...profileArg,
    },
    async ({ task, decision, body, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.reportReview(task, decision, body));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- messaging ----

  server.tool(
    "send_message",
    "Send a chat message as this agent into a channel. Use list_channels to find channel ids.",
    {
      channel: z.number().int().describe("Channel id to post in."),
      body: z.string().min(1).describe("Message body (markdown)."),
      priority: z
        .enum(["normal", "important", "urgent"])
        .optional()
        .describe("Message priority (default: normal)."),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Paths to attach, relative to the project root (or absolute, inside it). Max 25MB each.",
        ),
      ...profileArg,
    },
    async ({ channel, body, priority, files, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const attachments = files?.length
          ? await resolveAttachments(files, dirname(configPath))
          : undefined;
        return ok(
          await client.sendMessage({
            channel,
            body_markdown: body,
            priority,
            attachments,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "download_attachment",
    "Download a message attachment to disk and return its path. Get the `url` from an attachment on a message returned by check_messages. Returns a PATH, not the file's contents — open it with your own file-reading tool. Attachments are files in general: text and PDFs can be read directly, archives should be listed rather than read, and large files should be inspected in parts. Check `size_bytes` before reading anything wholesale.",
    {
      url: z
        .string()
        .min(1)
        .describe("The attachment's `url` from check_messages, e.g. /media/<key>."),
      name: z
        .string()
        .optional()
        .describe("Optional friendlier filename. Directory parts are stripped."),
      ...profileArg,
    },
    async ({ url, name, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { resolved } = picked;
        return ok(
          await downloadAttachment({
            url,
            name,
            server: resolved.server,
            key: resolved.key,
            root: dirname(configPath),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "check_messages",
    "Check for messages addressed to you. Returns only what you have NOT yet marked read, across every channel you're in. " +
      "IMPORTANT: after you have read and acted on the messages, call mark_read for each channel with the highest message id you handled — " +
      "otherwise they stay unread and you will be handed the same messages again on your next check. " +
      "Pass unread_only=false to re-read history you have already marked read.",
    {
      // Optional on purpose: an agent polling for new work has no channel id to
      // start from, and requiring one made "do I have any messages?"
      // unanswerable without first guessing an id.
      channel: z
        .number()
        .int()
        .optional()
        .describe("Channel id to read. Omit to check all channels you're in."),
      // Unread-by-default is the whole point: "what do I still owe a response
      // to?" is the question an agent actually has, and answering it
      // server-side means the agent cannot get it wrong by mis-comparing ids.
      unread_only: z
        .boolean()
        .optional()
        .describe("Default true — only messages past your read cursor. false returns full history."),
      since: z.number().int().optional().describe("Only return messages with id greater than this."),
      limit: z.number().int().optional().describe("Max messages (default 50, max 200)."),
      ...profileArg,
    },
    async ({ channel, unread_only, since, limit, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const unread = unread_only !== false;
        if (channel !== undefined) {
          const page = await client.listMessages({ channel, since, limit, unread });
          return ok({ ...page, reminder: markReadReminder(page.messages.length) });
        }
        // Fan out across the roster. Channels are few (a project room plus a
        // handful of DMs), so this stays one small burst rather than a paged
        // crawl. A per-channel failure must not sink the whole poll.
        const channels = await client.listChannels();
        const pages = await Promise.all(
          channels.map(async (c) => {
            try {
              const page = await client.listMessages({ channel: c.id, since, limit, unread });
              return { channel: c.id, title: c.title, ...page };
            } catch (err) {
              return { channel: c.id, title: c.title, error: (err as Error).message };
            }
          }),
        );
        // Drop empty channels when polling for unread: a wall of "0 messages"
        // buries the one channel that actually needs attention.
        const withMessages = unread
          ? pages.filter((p) => !("messages" in p) || (p.messages as unknown[]).length > 0)
          : pages;
        const total = withMessages.reduce(
          (n, p) => n + (("messages" in p ? (p.messages as unknown[]).length : 0)),
          0,
        );
        return ok({ channels: withMessages, total_unread: total, reminder: markReadReminder(total) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "mark_read",
    "Mark how far this agent has read in a channel (advance the read cursor forward).",
    {
      channel: z.number().int().describe("Channel id."),
      last_read_message: z.number().int().describe("The furthest message id now read."),
      ...profileArg,
    },
    async ({ channel, last_read_message, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.markRead(channel, last_read_message));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- sessions / terminal / activity ----

  server.tool(
    "register_session",
    "Register (or reconnect) a live session so humans see this agent online. Defaults the identifier to host:pid and cwd to the current directory.",
    {
      session_identifier: z.string().optional().describe("Stable session id (default host:pid)."),
      cwd: z.string().optional().describe("Working directory (default process.cwd())."),
      ...profileArg,
    },
    async ({ session_identifier, cwd, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client, resolved } = picked;
        const session = await client.registerSession({
          // Prefer the tmux pane, exactly as `ensureSession` and the mirror do.
          // Calling this with no argument always produced `host:pid`, so an
          // agent running under tmux ended up with TWO session rows — one from
          // this tool, one from the mirror's `tmux:<host>:<pane>` — which is
          // the duplication the mirror's own comment says it is avoiding.
          session_identifier:
            session_identifier?.trim() ||
            sessionIdentifier({ pane: await detectTmuxPane(), profileName: resolved.profileName }),
          host: hostname(),
          pid: process.pid,
          cwd: cwd ?? process.cwd(),
          transport: "mcp",
        });
        sessions.set(resolved.profileName, session.id);
        return ok(session);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "heartbeat",
    "Send a liveness heartbeat for the current session (auto-registers one if needed). Optional status hint: idle | busy.",
    {
      status: z.enum(["idle", "busy", "connected"]).optional().describe("Activity hint."),
      ...profileArg,
    },
    async ({ status, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client, resolved } = picked;
        const sessionId = await ensureSession(client, resolved.profileName);
        return ok(await client.heartbeat(sessionId, status));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "capture_terminal",
    "Stream a chunk of terminal output into the current session (auto-registers one if needed). Humans can watch it live.",
    {
      content: z.string().min(1).describe("Terminal text to append."),
      // All four backend variants: the UI colours stdin and system distinctly
      // (prompt green / dimmed italic), so narrowing this to stdout|stderr made
      // those styles unreachable through the only supported write path.
      stream: z
        .enum(["stdout", "stderr", "stdin", "system"])
        .optional()
        .describe("Which stream (default stdout). stdin echoes a command, system marks session notices."),
      ...profileArg,
    },
    async ({ content, stream, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client, resolved } = picked;
        const sessionId = await ensureSession(client, resolved.profileName);
        return ok(await client.appendFrame(sessionId, { content, stream }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "log_activity",
    "Log a real activity event (e.g. an action you took). Optionally attach it to a task.",
    {
      action: z.string().min(1).describe("Short verb (e.g. Read, Edit, Bash, note)."),
      body: z.string().optional().describe("Optional detail (markdown)."),
      task: z.number().int().optional().describe("Optional task id to link."),
      post_to_github: z
        .boolean()
        .optional()
        .describe(
          "Also post this event as a comment on the task's linked GitHub issue, under your owner's identity. Requires `task`. Best-effort: only posts when the project is GitHub-linked, the task is published as an issue, and your owner is connected and opted in (post_as_me) — otherwise it silently no-ops and the activity is still recorded.",
        ),
      ...profileArg,
    },
    async ({ action, body, task, post_to_github, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.logActivity({ action, body_markdown: body, task, post_to_github }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "get_activity",
    "Read recent activity in the project (newest first). Optional task filter and limit.",
    {
      task: z.number().int().optional().describe("Filter to one task's activity."),
      limit: z.number().int().optional().describe("Max events (default 50, max 200)."),
      ...profileArg,
    },
    async ({ task, limit, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.listActivity({ task, limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
