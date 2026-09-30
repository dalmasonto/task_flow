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
import { TaskflowClient, TaskflowApiError, type AgentSummary, type DesignLayoutOp } from "./client.js";
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
      name: "taskflow-mcp",
      version: "2.4.0",
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
    profile: ResolvedProfile,
  ): Promise<number> => {
    const { profileName } = profile;
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
      session_identifier: sessionIdentifier({
        pane: await paneOnce,
        profileName,
        project: profile.project,
        agentId: profile.agentId,
        configPath: profile.configPath,
      }),
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
      notes: z.string().optional().describe("Markdown notes."),
      claim: z.boolean().optional().describe("If true, assign the new task to this agent."),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Paths to attach to the new task, relative to the project root (or absolute, inside it). Max 25MB each.",
        ),
      ...profileArg,
    },
    async ({ title, description, notes, priority, claim, files, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const task = (await client.createTask({
          title,
          description_markdown: description,
          notes_markdown: notes,
          priority,
          claim,
        })) as { id?: number };

        if (!files?.length) return ok(task);

        // Attachments can only be hung on a task that exists, so this is a
        // second call. If it fails the task is ALREADY created — reporting a
        // plain error would send the caller off to create a duplicate, so say
        // what happened and hand back the id it can retry against.
        // A malformed create response must not become a confusing 404 from
        // `/agents/tasks/undefined/attachments`.
        if (typeof task.id !== "number") {
          return ok({
            ...task,
            attachments: [],
            warning:
              "The task was created but the server did not return its id, so the files could not be attached. Find the task and attach them to it.",
          });
        }

        try {
          const attachments = await resolveAttachments(files, dirname(configPath));
          const uploaded = (await client.uploadTaskAttachments(task.id, attachments)) as {
            attachments?: unknown[];
          };
          return ok({ ...task, attachments: uploaded?.attachments ?? [] });
        } catch (err) {
          return ok({
            ...task,
            attachments: [],
            warning: `The task was created (id ${task.id}) but attaching files failed: ${
              err instanceof Error ? err.message : String(err)
            }. Do NOT create the task again — retry the upload against this id.`,
          });
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "update_task",
    "Edit a task's content in the agent's project: title, description, notes, priority, and/or attach files. Only the fields you pass are changed — anything you omit is left as it is. Use update_task_status to move a task's status, and claim_task to assign it. Returns the updated task.",
    {
      task: z.number().int().describe("Task id."),
      title: z.string().min(1).optional().describe("New title."),
      description: z.string().optional().describe("New markdown description (replaces)."),
      notes: z.string().optional().describe("New markdown notes (replaces)."),
      priority: z
        .enum(["low", "normal", "high", "critical"])
        .optional()
        .describe("New task priority."),
      files: z
        .array(z.string())
        .optional()
        .describe(
          "Paths to attach to this task, relative to the project root (or absolute, inside it). Max 25MB each. Attaching is additive — it never removes existing attachments.",
        ),
      ...profileArg,
    },
    async ({ task, title, description, notes, priority, files, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;

        // Nothing to do is a caller mistake worth naming: a no-op that returns
        // the task unchanged reads as success and hides the missing argument.
        const hasFields =
          title !== undefined ||
          description !== undefined ||
          notes !== undefined ||
          priority !== undefined;
        if (!hasFields && !files?.length) {
          return fail(
            new Error(
              "Nothing to update: pass at least one of title, description, notes, priority or files.",
            ),
          );
        }

        let updated: unknown = undefined;
        if (hasFields) {
          updated = await client.updateTask(task, {
            title,
            description_markdown: description,
            notes_markdown: notes,
            priority,
          });
        }

        if (!files?.length) return ok(updated);

        const base = typeof updated === "object" && updated !== null ? updated : { id: task };

        // Same shape as `create_task`: the FIELDS are already written by the
        // time an upload can fail, so reporting a bare error would tell the
        // caller their edit did not land and invite them to send it again.
        // `uploadTaskAttachments` carries no client_nonce, so a blind retry
        // duplicates the attachments.
        try {
          const attachments = await resolveAttachments(files, dirname(configPath));
          const uploaded = (await client.uploadTaskAttachments(task, attachments)) as {
            attachments?: unknown[];
          };
          return ok({ ...base, attachments: uploaded?.attachments ?? [] });
        } catch (err) {
          return ok({
            ...base,
            attachments: [],
            warning: `${
              hasFields ? "The edit was applied" : "Nothing was changed"
            } but attaching files failed: ${
              err instanceof Error ? err.message : String(err)
            }. Do NOT re-send the fields — retry only the upload.`,
          });
        }
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
    "Send a chat message as this agent into a channel. Use list_channels to find channel ids. To ANSWER a specific message, pass its id as `reply_to` (the `message=` id in a delivered notice's ⟦ctx⟧ block, or `id` from check_messages): the reply is linked to it and shown quoted, so a thread stays readable when several conversations interleave. `reply_to` must be a message in the same channel. To MENTION someone or a design page, write it by id so it renders as a chip and cannot be confused with a similar name: [@Name](agent:ID), [@Name](user:ID) (ids from list_agents / the ⟦ctx⟧ from= field), or [@Page name](page:/route). You will see mentions of you in the same form.",
    {
      channel: z.number().int().describe("Channel id to post in."),
      body: z.string().min(1).describe("Message body (markdown)."),
      reply_to: z
        .number()
        .int()
        .optional()
        .describe("The id of the message this answers (same channel). Omit for a new line of conversation."),
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
      is_design: z
        .boolean()
        .optional()
        .describe(
          "Ignored for placement — the destination channel decides where a message lands; kept only for compatibility. Design has its own room (one per project: the channel with is_design true in list_channels), so post design replies there.",
        ),
      ...profileArg,
    },
    async ({ channel, body, reply_to, priority, files, is_design, profile }) => {
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
            is_design,
            attachments,
            ...(reply_to === undefined ? {} : { reply_to }),
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
            sessionIdentifier({
              pane: await detectTmuxPane(),
              profileName: resolved.profileName,
              project: resolved.project,
              agentId: resolved.agentId,
              configPath: resolved.configPath,
            }),
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
        const sessionId = await ensureSession(client, resolved);
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
        const sessionId = await ensureSession(client, resolved);
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

  // ---- Design Surface -------------------------------------------------------
  // The design tools are the ONLY sanctioned way an agent touches a project's
  // generated UI. There is no generic write_file on purpose: pages compose from
  // registered custom elements and one token scale, and anything else is a
  // rejected write (that rejection is the feature — read the errors, they name
  // the rule and the token to use instead).

  /** Resolve the tool's `project` argument against this credential's project. */
  const designProjectArg = {
    project: z
      .number()
      .int()
      .optional()
      .describe(
        "The project id whose design you are editing. Normally OMIT it: your credential pins " +
          "one project and that is what will be used. Passing another id is refused, not routed.",
      ),
  };

  // Shared by the layout writes. Optional on purpose: omitted, the server works
  // from the version it currently holds, so an agent that never read is never
  // blocked. Supply one (from design_read_layout's `version`) to be TOLD when
  // someone else moved the board instead of writing over them.
  const baseVersionArg = {
    base_version: z
      .number()
      .int()
      .optional()
      .describe(
        "The layout version you read. Optional: omit and the write applies to the current board. Supply it to get a 409 instead of overwriting a change you have not seen.",
      ),
  };

  // The same fact again in each tool's DESCRIPTION, because the two answer
  // different questions: the argument's schema can say the field is optional,
  // but not that omitting it is the ORDINARY case — an agent that has not read
  // the board has to be able to tell that it may still write.
  // The 409 says WHAT happened, not what the board now holds: the message is
  // the sentence an agent reads, while `current_version` and
  // `current_document` sit in the body beside it and never reach the tool
  // result. So the promise is "you will be told, and you re-read to merge" —
  // never "the current arrangement comes back with it".
  const baseVersionNote =
    "`base_version` is optional and omitting it is the normal case: the write then applies " +
    "to the board as it stands, so an agent that never read is never blocked. Supply " +
    "design_read_layout's `version` to be told (409) instead of overwriting a change you " +
    "have not seen — the refusal says the board moved on, and design_read_layout is where " +
    "you re-read the arrangement and merge.";

  async function resolveDesignProject(
    client: TaskflowClient,
    project?: number,
  ): Promise<number> {
    if (project !== undefined) return project;
    const identity = (await client.whoami()) as { project?: number };
    if (typeof identity.project !== "number") {
      throw new Error("Could not resolve your project id; call whoami.");
    }
    return identity.project;
  }

  server.tool(
    "design_get_tokens",
    "Read the design token scale as BOTH the json map (`tokens_json`, the source of truth) and generated CSS (`tokens_css`). ALWAYS call this before your first design write: raw hex/px values are rejected — colour and spacing must come from these variables (e.g. bg-[var(--accent)]). The response also includes a `primitives` array documenting the built-in <ui-*> components (ui-accordion/ui-dialog/ui-sheet/ui-tabs) with their attrs and usage examples, and a `guide` string with the sandbox rules that are in no manifest: how a page links to another page, how a back control is written, and what a page may load from outside the sandbox. Read `guide` before your first fragment — it answers questions the registry cannot. The response's `resources` field is the project's styles/resources.json (webfonts loaded once for every page; null when none).",
    { ...designProjectArg, ...profileArg },
    async ({ project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.designContext(await resolveDesignProject(client, project)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_list_components",
    "List the project's component registry: every custom element, its attributes, where it is used (usedOn routes + usage counts), and the page routes. Compose pages from THESE — do not invent new tags. Also see the response's `primitives` array for built-in <ui-*> tags (accordion/dialog/sheet/tabs) with names, attrs, and usage examples.",
    { ...designProjectArg, ...profileArg },
    async ({ project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.designContext(await resolveDesignProject(client, project)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_read_layout",
    "Read how the project's PAGES ARE ARRANGED: the named page groups and what each one holds, the flow (the order the pages are presented in and the canvas draws in), and the name each page is listed under. design_list_components returns the registry as a FLAT array with no group and no order, so the arrangement cannot be recovered from it — if you need to know how pages are grouped, or in which order they come, ask THIS. Nothing to select: the arrangement is one document per project, so there is no route, group id or name to pass. `view` is the canvas arrangement (rows/bands/groups/flow — `flow` is the user-flow canvas) and the grouping reads the same in every one. `version` is THIS arrangement's version — hand it to a layout write as `base_version` to be told if someone rearranged the board under you. (Note `revision` next to it is a different number: the manifest's, which moves when a page changes.) It also returns the USER FLOW drawn as arrows on the Flow canvas: `edges` is a list of `{id, from, to, label?}` — a user goes from route `from` to route `to`, and the optional label names the path (\"new user\" / \"existing user\") — and `positions` maps a route to its fixed `{x, y}` node on that canvas (an unlisted page is auto-placed). Arrange the board with design_create_group, design_update_group, design_reorder_group, design_reorder_page and design_delete_group; draw the flow with design_link_pages and design_unlink_pages — or several edits at once with design_arrange (which also takes update_link and place_page) — all of which take operations — never PUT a document built from this response back, because this is the panel's view and not the stored form.",
    // The arrangement is one document per project, so there is nothing to
    // select: a route or a group id would be an argument this read has no use
    // for. The description says so as well, because a schema shows only what is
    // absent and an agent cannot tell "nothing more to pass" from "I was going
    // to pass the wrong thing".
    { ...designProjectArg, ...profileArg },
    async ({ project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.readDesignLayout(await resolveDesignProject(client, project)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- Arranging the board --------------------------------------------------
  // The four writes take an OPERATION, tagged by which edit it is, and never a
  // document: design_read_layout is the panel's view and comes back lossy, so a
  // document rebuilt from it would store something the reader never saw. Each
  // operation says what to change and nothing else, which is what makes these
  // safe to apply to a board the caller has not read — and why `base_version`
  // can be optional rather than mandatory.

  server.tool(
    "design_create_group",
    "Add a named page group to the project's arrangement — the Pages panel's groups, which decide how screens are sectioned. The name must be non-blank, at most 40 characters, and not already used in THIS project (names are compared case-insensitively; another project may use the same name). Returns the new group's id in `changed.groups`; put pages in it with design_reorder_page. " +
      baseVersionNote,
    {
      ...designProjectArg,
      name: z.string().describe("The group name."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, name, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { create_group: { name } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_update_group",
    "Rename one page group. Membership and order are untouched, so a rename can never empty a group or move a page — putting pages somewhere is design_reorder_page's job, and a group is emptied by moving its pages out (or removed with design_delete_group), never by renaming it. `group_id` comes from design_read_layout, or from the id design_create_group returned in `changed.groups`. The name must be non-blank, at most 40 characters, and not already used in this project (as with design_create_group). " +
      baseVersionNote,
    {
      ...designProjectArg,
      group_id: z.string().describe("The id of the group to rename, from design_read_layout."),
      name: z.string().describe("The new name."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, group_id, name, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { update_group: { group_id, name } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_reorder_group",
    "Move one page group to a 1-based SLOT in the group list: `position` is an ABSOLUTE slot (1 is the first group), not a delta to shift by. It is a MOVE, not a swap — the groups between the old slot and the new one slide along and keep their relative order. Out of range is REFUSED, never clamped, because a clamped move lands somewhere nobody asked for: a slot past the last group comes back as a 400 naming the valid range, and a slot below 1 is refused before the call is sent. The Pages panel does clamp a drag, so a slot it would have quietly accepted is an error here. `group_id` and the group count come from design_read_layout. " +
      baseVersionNote,
    {
      ...designProjectArg,
      group_id: z.string().describe("The id of the group to move, from design_read_layout."),
      position: z.number().int().min(1).describe("The 1-based slot to move it to — absolute, not a delta."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, group_id, position, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { reorder_group: { group_id, position } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // `registerTool`, not `tool`, for one reason: `server.tool` takes a raw SHAPE,
  // which is a record of independent field schemas and cannot carry a rule that
  // spans two fields. "At least one of group_id / position" is exactly that kind
  // of rule, and the backend refuses a call with neither — so without a refined
  // object schema the MCP would send every such call to a 400 it can predict.
  // The published wire shape is identical either way (same flat `properties`),
  // so this changes nothing an agent sees except that the mistake is refused
  // before the write leaves.
  server.registerTool(
    "design_reorder_page",
    {
      description:
        "Place a page into a group and/or at a 1-based position within that section — the numbering the Pages panel shows, NOT an index into the flow, which is global and sparse and which no reader ever sees. At least one of `group_id` or `position` is required: naming neither asks for nothing and is refused. Passing only `group_id` APPENDS the page to that group's section, so a page you merely want IN a group lands at the end of it — pass `position` as well to choose the slot. Passing only `position` reorders the page within the section that already holds it. Both together do both in one write, which is how a page moves between groups as a single edit rather than two that can half-succeed. `position` is 1..=the number of pages in the resulting section (its append slot); out of range is refused, not clamped. Moving a page renumbers the section it left and the one it joined; other sections are unaffected, because their members keep their relative order in the flow. The response's `changed.routes` names every page whose visible position moved, and always the page you named. " +
        baseVersionNote,
      inputSchema: z
        .object({
          route: z.string().min(1).describe("The page's route, e.g. '/settings'."),
          group_id: z
            .string()
            .optional()
            .describe("The group to place it in; omit to keep the section that holds it."),
          position: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("The 1-based slot within the resulting section; omit to append to it."),
          ...designProjectArg,
          ...profileArg,
          ...baseVersionArg,
        })
        // The backend's own message, so the two refusals tell the same story.
        .refine((v) => v.group_id !== undefined || v.position !== undefined, {
          message: "reorder_page needs a group_id, a position, or both.",
        }),
    },
    async ({ route, group_id, position, project, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: {
              reorder_page: {
                route,
                ...(group_id === undefined ? {} : { group_id }),
                ...(position === undefined ? {} : { position }),
              },
            },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_delete_group",
    "Remove one page group. Its pages are NOT deleted: they fall back to the Ungrouped section, keeping their flow order — this removes a grouping, never a screen. `group_id` comes from design_read_layout (or from design_create_group's `changed.groups`); an unknown id is refused rather than ignored. " +
      baseVersionNote,
    {
      ...designProjectArg,
      group_id: z.string().describe("The id of the group to remove, from design_read_layout."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, group_id, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { delete_group: { group_id } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---- The user flow (#508) --------------------------------------------------
  server.tool(
    "design_link_pages",
    "Draw a flow arrow from one page to another. The Flow canvas draws the project's USER FLOW: each link is a directed arrow saying a user goes from one screen to another (e.g. `/welcome` → `/signup` labelled \"new user\", `/welcome` → `/login` labelled \"existing user\"). " +
      "Use it to show how a user moves between screens, including branches: link one screen to two others with different labels. `from` and `to` are routes (as design_read_layout's `pages[].route`); both must be pages in this project, a page cannot link to itself, and one arrow per direction (`/a`→`/b` and `/b`→`/a` are two different arrows; a second `/a`→`/b` is refused). `label` is optional, at most 40 characters. Returns the new link's id in `changed.edges` — keep it to relabel (design_arrange's update_link) or remove (design_unlink_pages) the arrow. " +
      baseVersionNote,
    {
      ...designProjectArg,
      from: z.string().min(1).describe("The route the user starts on, e.g. \"/welcome\"."),
      to: z.string().min(1).describe("The route the user goes to, e.g. \"/signup\"."),
      label: z
        .string()
        .max(40)
        .optional()
        .describe("Optional short label for the path, e.g. \"new user\" or \"existing user\"."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, from, to, label, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { link_pages: { from, to, ...(label === undefined ? {} : { label }) } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_unlink_pages",
    "Remove one flow arrow from the Flow canvas (the pages themselves are untouched). Name it by `edge_id` (from design_read_layout's `edges[].id`, or the id design_link_pages returned in `changed.edges`) OR by both `from` and `to` routes — one way, not both. An unknown link is refused rather than ignored. " +
      baseVersionNote,
    {
      ...designProjectArg,
      edge_id: z.string().min(1).optional().describe("The link's id, from design_read_layout's `edges`."),
      from: z.string().min(1).optional().describe("Instead of edge_id: the arrow's start route (with `to`)."),
      to: z.string().min(1).optional().describe("Instead of edge_id: the arrow's end route (with `from`)."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, edge_id, from, to, base_version, profile }) => {
      try {
        const byId = edge_id !== undefined && from === undefined && to === undefined;
        const byPair = edge_id === undefined && from !== undefined && to !== undefined;
        if (!byId && !byPair) {
          throw new Error("Name the link by `edge_id`, or by both `from` and `to` (one way, not both).");
        }
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            op: { unlink_pages: byId ? { edge_id: edge_id! } : { from: from!, to: to! } },
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // #501: one op of a design_arrange batch — the same edits the single
  // tools make, in the route's own wire shape (plus #508's update_link and
  // place_page, which exist only here).
  const coord = z.number().finite();
  const layoutOpSchema = z.union([
    z.object({ create_group: z.object({ name: z.string() }).strict() }).strict(),
    z.object({ update_group: z.object({ group_id: z.string(), name: z.string() }).strict() }).strict(),
    z
      .object({ reorder_group: z.object({ group_id: z.string(), position: z.number().int().min(1) }).strict() })
      .strict(),
    z
      .object({
        reorder_page: z
          .object({
            route: z.string().min(1),
            group_id: z.string().optional(),
            position: z.number().int().min(1).optional(),
          })
          .strict()
          .refine((v) => v.group_id !== undefined || v.position !== undefined, {
            message: "reorder_page needs a group_id, a position, or both.",
          }),
      })
      .strict(),
    z.object({ delete_group: z.object({ group_id: z.string() }).strict() }).strict(),
    z
      .object({
        link_pages: z
          .object({ from: z.string().min(1), to: z.string().min(1), label: z.string().max(40).optional() })
          .strict(),
      })
      .strict(),
    z
      .object({
        unlink_pages: z.union([
          z.object({ edge_id: z.string().min(1) }).strict(),
          z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        update_link: z.object({ edge_id: z.string().min(1), label: z.string().max(40).optional() }).strict(),
      })
      .strict(),
    z
      .object({ place_page: z.object({ route: z.string().min(1), x: coord, y: coord }).strict() })
      .strict(),
  ]);

  server.tool(
    "design_arrange",
    "Apply SEVERAL arrangement edits as ONE write: `ops` is an ordered list, each item exactly one of {\"create_group\":{name}}, {\"update_group\":{group_id,name}}, {\"reorder_group\":{group_id,position}}, {\"reorder_page\":{route,group_id?,position?}}, {\"delete_group\":{group_id}}, and for the USER FLOW on the Flow canvas (arrows showing how a user moves between screens): {\"link_pages\":{from,to,label?}}, {\"unlink_pages\":{edge_id} or {from,to}}, {\"update_link\":{edge_id,label?}} (relabel an arrow; omit label to clear it), {\"place_page\":{route,x,y}} (pin a page's node at canvas coordinates, clamped to ±100000; this is NOT reorder_page, which moves a page in the list) — the same rules as the single tools of those names. Use it to file many pages into groups, reorder a whole section, or lay out a whole flow (link the screens and place each node) in one call. Link ids are minted by the server and reported in `changed.edges`; placed routes in `changed.positions`. The ops run in order, each on the result of the one before, and the batch is ALL OR NOTHING: if any op is refused, none is stored and the error names the failing index (`ops[2] (reorder_page) ...`). The whole batch is one version. A group created in the batch gets its id minted by the server, so a later op in the SAME batch cannot name it — create first, then arrange with the id from `changed.groups`. 1 to 100 ops; a one-item list behaves exactly like the single tool. " +
      baseVersionNote,
    {
      ...designProjectArg,
      ops: z.array(layoutOpSchema).min(1).max(100).describe("The edits, applied in order as one all-or-nothing write."),
      ...profileArg,
      ...baseVersionArg,
    },
    async ({ project, ops, base_version, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeLayoutOp({
            project: await resolveDesignProject(client, project),
            ops: ops as DesignLayoutOp[],
            ...(base_version === undefined ? {} : { base_version }),
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_read_component",
    "Read one component's source, version, and the routes that use it.",
    {
      name: z.string().min(1).describe("Component name, e.g. 'app-header'."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ name, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.readDesignComponent(await resolveDesignProject(client, project), name));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_read_page",
    "Read one page's HTML body fragment (never a full document — the shell is server-composed) plus its version for optimistic writes.",
    {
      route: z.string().min(1).describe("Route path, e.g. '/' or '/settings'."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ route, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.readDesignPage(await resolveDesignProject(client, project), route));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_write_page",
    "Write a page's BODY FRAGMENT (no <html>/<head>/<body>, no inline <style>, no raw <header>/<nav>/<footer>/<aside> — use registered components like <app-header>). Styling via Tailwind classes on the TOKEN scale only: bg-[#3b82f6] is rejected; bg-[var(--accent)] is not. Do NOT put a webfont <link> or its preconnect in a page — it loads for that page only; load it once in styles/resources.json via design_write_asset (a page that carries one is accepted with a `page-resource-link` warning). Built-in <ui-accordion>/<ui-dialog>/<ui-sheet>/<ui-tabs> primitives are also available server-expanded — see design_get_tokens's `primitives` field for their names, attrs, and usage examples. CREATE SCREEN: this is the tool that adds one. If `route` does not exist yet, this call creates it — routes are derived from the page files, so writing '/billing' is all it takes and the new screen renders at the sandbox URL and appears in the manifest immediately. There is no separate create-page call to look for. Pass base_version from design_read_page so a sibling agent's concurrent edit conflicts loudly instead of being clobbered silently; omit it when the route is new.",
    {
      route: z.string().min(1).describe("Route path to write or CREATE, e.g. '/settings'. A route that does not exist yet is created by this call."),
      html: z.string().min(1).describe("The full replacement fragment."),
      base_version: z.number().int().optional().describe("Version from design_read_page; omit to force."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ route, html, base_version, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeDesignPage(await resolveDesignProject(client, project), route, html, base_version),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_write_component",
    "Register or update ONE custom element (one per file, light DOM, Tailwind + tokens). Requires `reason` — state why the registry must change; instance tweaks belong in page attributes instead. Banned inside components: fetch/XHR, eval/new Function/import(), localStorage/cookies, attachShadow. The response names every route you just touched.",
    {
      name: z.string().min(1).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/)
        .describe("Custom element name WITH a hyphen, e.g. 'app-header' — must match the define() in js."),
      js: z.string().min(1).describe("Full file source with exactly one customElements.define('<name>', …)."),
      reason: z.string().min(8).describe("Why the registry must change (e.g. 'no text input in registry')."),
      base_version: z.number().int().optional(),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ name, js, reason, base_version, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeDesignComponent(await resolveDesignProject(client, project), name, js, reason, base_version),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_delete_component",
    "Retire one component from the registry — the other half of design_write_component, for a part nothing needs any more. REFUSED while any page still uses it, and the refusal names those routes: remove the tag from them first (design_read_page, then design_write_page), because a page that references a component the registry no longer has renders without its definition and cannot be edited until that reference is gone — a write that KEEPS the tag is refused with `unknown-component`; one that removes it is accepted, so the repair is a rewrite that drops the tag — not deleting and recreating the page. Requires `reason`. Check the blast radius with design_read_component (its `usedOn`) before calling this.",
    {
      name: z.string().min(1).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/)
        .describe("Custom element name WITHOUT the .js — e.g. 'app-header'."),
      reason: z.string().min(8).describe("Why this component should no longer exist."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ name, reason, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.deleteDesignComponent(await resolveDesignProject(client, project), name, reason),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_delete_page",
    "Move one page (screen) to the TRASH — for a screen that is unwanted, a failed draft, or superseded. It stops rendering and drops out of the manifest, the canvas and the Pages panel at once, but it is NOT destroyed: the operator can restore it from the Pages panel's trash. Requires `reason` (at least 8 characters), which the operator reads when deciding whether to restore. Writing a NEW page at the same route later (design_write_page) discards the trashed copy for good. To remove a GROUP rather than a page, use design_delete_group — that keeps every page.",
    {
      route: z.string().min(1).describe("The page's route, e.g. '/settings' ('/' is the index page)."),
      reason: z.string().min(8).describe("Why this page should go."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ route, reason, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.trashDesignPage(await resolveDesignProject(client, project), route, reason));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_write_asset",
    "Write one file that is NOT a page, a component or the token scale. Two shapes: `assets/<name>` — an image file (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.ico`; a bare name like 'logo.svg' means assets/logo.svg) — or `styles/resources.json`, the external-resources document naming the project's web fonts and external script links, which design_write_tokens does NOT write. THIS is where a webfont is loaded: its enabled sets go into the head of EVERY page, so a typeface is one token (typography.font-sans) plus this one file — never a <link> per page. Shape: {\"version\":1,\"sets\":[{\"id\":\"font\",\"name\":\"Font\",\"enabled\":true,\"links\":[{\"rel\":\"preconnect\",\"href\":\"https://cdn.jsdelivr.net\",\"crossorigin\":true},{\"rel\":\"stylesheet\",\"href\":\"https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5/index.css\"}]}]} (https only; rel stylesheet/preconnect/dns-prefetch). design_get_tokens returns the current document and its version in `resources`. The operator often manages its sets from the panel: when it exists, change only what you need (usually `enabled` flags) and keep every other set as is. Content is TEXT, exactly like every other design write: an SVG goes in as its own markup, and raster bytes as `data:<image/png>;base64,<payload>`, which the server decodes when the file is served. An asset is served from the sandbox origin at `/s/{token}/f/assets/<name>` with its own content type — but nothing rewrites an `src=` into a sandbox URL the way links are rewritten, so a page cannot point at it by a relative path: for an image a page shows today use an https URL or a data: URI inside the fragment. Caps unchanged: 128 KB per file (rule `size-cap`), and a NEW file must also fit the project's 200-file / 4 MB budget. Pass base_version only when replacing an existing file.",
    {
      path: z.string().min(1).describe("'logo.svg' (bare name → assets/logo.svg), 'assets/logo.svg', or 'styles/resources.json'."),
      content: z.string().describe("File text. Raster images as a data:<mime>;base64,<payload> string."),
      base_version: z.number().int().optional().describe("Version from a prior read; omit to force a replacement."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ path, content, base_version, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeDesignAsset(await resolveDesignProject(client, project), path, content, base_version),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_write_tokens",
    "Change the design tokens. Touches EVERY route and component at once — requires `reason`. Pass EXACTLY ONE of: `patch` (PREFERRED for edits: only the tokens you change, merged into the stored document — {\"colors\":{\"primary\":{\"light\":\"#448502\"}}}; a token replaces only the themes it names; null removes it; design_compare's apply[label].patch is exactly this), `tokens` (the whole document, for a real replacement: {\"version\":1,\"categories\":{\"colors\":{\"accent\":{\"light\":\"#6366f1\",\"dark\":\"#818cf8\"}}}}) or `css` (legacy tokens.css text). `base_version` refuses with a conflict if the tokens changed since you read them. Prefer adding variables over changing existing ones mid-project. Changing the typeface: set typography.font-sans here AND the webfont stylesheet in styles/resources.json (design_write_asset) — no page edits.",
    {
      tokens: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          "Preferred. The full tokens document: {version, categories: {colors|spacing|radius|typography|shadows|custom: {<key>: {light, dark?}}}}.",
        ),
      css: z.string().min(1).optional().describe("Legacy: complete tokens.css content (parsed into the json shape)."),
      patch: z
        .record(z.string(), z.record(z.string(), z.union([z.object({ light: z.string().optional(), dark: z.string().nullable().optional() }), z.null()])))
        .optional()
        .describe("Preferred for edits: {category: {key: {light?, dark?} | null}} — only these change."),
      base_version: z.number().int().optional().describe("The tokens version you read (e.g. design_compare's tokens_version); a stale one is refused."),
      reason: z.string().min(8).describe("Why the tokens change."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ tokens, css, patch, base_version, reason, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(
          await client.writeDesignTokens(await resolveDesignProject(client, project), reason, {
            tokens,
            css,
            patch,
            base_version,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_screenshot",
    "Render a route in headless Chromium and return a PNG. You cannot see the UI otherwise — call this on a route BEFORE and AFTER your edits and self-critique the result. " +
      "Phone/tablet viewports render as a real mobile browser (touch, mobile user agent). " +
      "Size: a preset `viewport`, or a custom `width`+`height` (CSS px, 200–4000) with optional `dpr` (1–4). " +
      "`full_page: true` captures the whole scrollable page, not one screen. " +
      "`frame` dresses the shot like the Design Surface export: 'device' (a realistic device frame with status bar), 'classic' (the simple black bezel) or 'none' (default) — use a frame when the picture is for your human. " +
      "`theme`: 'light' (default), 'dark', or 'both' (light and dark side by side in one image) — check dark whenever you touch colour. " +
      "`tokens`/`css` render UNSAVED overrides (try a colour before writing it; use design_compare to see options side by side). " +
      "`state='dialog:confirm-delete'` opens that overlay first. The reply lists WARNINGS for any font, image or stylesheet that did not load: fix or mention them, do not ignore them.",
    {
      route: z.string().min(1).describe("Route path to render, e.g. '/settings'."),
      viewport: z
        .string()
        .min(1)
        .default("laptop")
        .describe("Device preset id: iphone-se, iphone-16-pro, iphone-16-pro-max, pixel-8, galaxy-s24, ipad-mini, ipad-pro-11, ipad-pro-13, laptop, laptop-l, desktop, bp-sm…bp-2xl. Also picks the device frame."),
      width: z.number().int().min(200).max(4000).optional().describe("Custom width in CSS px (with height); overrides the preset's size."),
      height: z.number().int().min(200).max(4000).optional().describe("Custom height in CSS px (with width)."),
      dpr: z.number().int().min(1).max(4).optional().describe("Device pixel ratio (default: the preset's, or 1 for a custom size)."),
      mobile: z.boolean().optional().describe("Force mobile emulation on/off (default: on for phones/tablets and custom widths up to 1024)."),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page."),
      frame: z.enum(["none", "classic", "device"]).optional().describe("How to dress the shot (default none)."),
      theme: z.enum(["light", "dark", "both"]).optional().describe("Render light (default), dark, or both side by side."),
      tokens: z
        .record(z.string(), z.union([z.string(), z.object({ light: z.string().optional(), dark: z.string().optional() })]))
        .optional()
        .describe('UNSAVED token overrides to render with, e.g. {"--primary": "#448502"} or {"--bg": {"dark": "#0b0b0c"}}. Nothing is written.'),
      css: z.string().optional().describe("UNSAVED extra CSS for what tokens cannot express (no url(), @, or comments)."),
      max_px: z
        .number()
        .int()
        .min(0)
        .max(8000)
        .optional()
        .describe("Longest side of the returned image (default 1568, what you can read; 0 = full resolution, e.g. to hand to a human)."),
      state: z.string().optional().describe("Overlay state to open on load, e.g. 'dialog:confirm-delete'."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ route, viewport, width, height, dpr, mobile, full_page, frame, theme, tokens, css, max_px, state, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const projectId = await resolveDesignProject(client, project);
        const shot = await client.designScreenshot(projectId, route, viewport, state, {
          width,
          height,
          dpr,
          mobile,
          full_page,
          frame,
          theme,
          tokens,
          css,
          max_px,
        });
        if (!shot.png_base64) throw new Error("Renderer returned no image.");
        const size = shot.size
          ? ` (${shot.size.width}×${shot.size.height} @${shot.size.dpr}x${shot.size.mobile ? ", mobile" : ""})`
          : "";
        const dress = shot.frame && shot.frame !== "none" ? `, ${shot.frame} frame` : "";
        const shade =
          shot.theme === "both" ? ", light (left) and dark (right)" : shot.theme === "dark" ? ", dark" : "";
        const warnings = shot.warnings?.length
          ? `\n\nWARNINGS — the picture differs from a real browser here:\n${shot.warnings.map((w) => `- ${w}`).join("\n")}`
          : "";
        return {
          content: [
            {
              type: "image",
              data: shot.png_base64,
              mimeType: "image/png",
            },
            {
              type: "text",
              text:
                `Screenshot of ${shot.route} at ${shot.viewport}${size}${shade}${shot.full_page ? ", full page" : ""}${dress}. ` +
                `Self-critique it against the tokens scale and your instruction before calling it done.${warnings}`,
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_compare",
    "Render several screens × several UNSAVED design variants × light/dark as ONE labelled image grid — the way to answer 'which colour/type/spacing?' with your human. " +
      "Columns are variants (a variant with no overrides is the live design — include it as 'Current'), rows are route × theme. Nothing is written. " +
      "Each variant's `tokens` are CSS custom-property overrides ({\"--primary\": \"#448502\"} or per theme {\"--bg\": {\"light\": …, \"dark\": …}}); `css` is extra CSS for what tokens cannot express. " +
      "`checks` measure WCAG contrast of fg on bg per variant and theme, as rendered. " +
      "Top-level `tokens`/`css` apply to EVERY variant (e.g. CSS forcing a sheet open) — a variant's own win. " +
      "`include_apply: true` adds, per variant, the PATCH that would make it the design: pass apply[label].patch as `patch` to design_write_tokens (with base_version = tokens_version). Leave it off when you are only looking. " +
      "Images fit `max_px` (default 1568); a grid whose cells would be unreadably small is split into one image per route. " +
      "Limits: 1–6 routes, 1–4 variants, at most 24 cells.",
    {
      routes: z
        .array(z.union([z.string().min(1), z.object({ route: z.string().min(1), state: z.string().optional(), label: z.string().optional() })]))
        .min(1)
        .max(6)
        .describe("Routes to compare, e.g. ['/setup', {route: '/user', state: 'dialog:report'}]."),
      variants: z
        .array(
          z.object({
            label: z.string().min(1).max(60),
            tokens: z
              .record(z.string(), z.union([z.string(), z.object({ light: z.string().optional(), dark: z.string().optional() })]))
              .optional(),
            css: z.string().optional(),
          }),
        )
        .min(1)
        .max(4)
        .describe("Columns. [{label: 'Current'}, {label: 'Lime AA', tokens: {'--primary': '#448502'}}]."),
      themes: z.array(z.enum(["light", "dark"])).min(1).max(2).optional().describe("Default ['light']."),
      viewport: z.string().optional().describe("Device preset for every cell (default iphone-16-pro)."),
      width: z.number().int().min(200).max(4000).optional().describe("Custom cell width in CSS px (with height)."),
      height: z.number().int().min(200).max(4000).optional().describe("Custom cell height in CSS px (with width)."),
      checks: z
        .array(z.object({ fg: z.string(), bg: z.string(), label: z.string().optional() }))
        .max(6)
        .optional()
        .describe("Contrast pairs, e.g. [{fg: '--primary-foreground', bg: '--primary', label: 'button text'}]."),
      scale: z.number().min(0.2).max(1).optional().describe("Cell scale (default 0.5)."),
      tokens: z
        .record(z.string(), z.union([z.string(), z.object({ light: z.string().optional(), dark: z.string().optional() })]))
        .optional()
        .describe("Overrides EVERY variant starts from; a variant's own override the same name."),
      css: z.string().optional().describe("CSS every variant gets (before its own)."),
      include_apply: z.boolean().optional().describe("Return apply[label].patch per variant (default false)."),
      max_px: z.number().int().min(0).max(8000).optional().describe("Longest side of each image (default 1568; 0 = full size)."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ routes, variants, themes, viewport, width, height, checks, scale, tokens, css, include_apply, max_px, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const projectId = await resolveDesignProject(client, project);
        const out = await client.designCompare(projectId, {
          routes,
          variants,
          themes,
          viewport,
          width,
          height,
          checks,
          scale,
          tokens,
          css,
          include_apply,
          max_px,
        });
        if (!out.images?.length) throw new Error("Renderer returned no image.");
        const lines = [
          `Compare grid: columns ${out.grid.columns.join(" | ")}; rows ${out.grid.rows.map((r) => `${r.label ?? r.route} (${r.theme})`).join(", ")}.`,
        ];
        if (out.split) {
          lines.push(`Split into ${out.images.length} images (one per route, in order) so the cells stay readable.`);
        }
        if (out.checks.length) {
          lines.push("", "Contrast (WCAG, as rendered):");
          for (const c of out.checks) {
            lines.push(
              c.error
                ? `- ${c.variant} · ${c.theme} · ${c.label ?? `${c.fg} on ${c.bg}`}: ${c.error}`
                : `- ${c.variant} · ${c.theme} · ${c.label ?? `${c.fg} on ${c.bg}`}: ${c.fgValue} on ${c.bgValue} = ${c.ratio}:1 ${c.aa ? "AA ✓" : c.aaLarge ? "AA large only" : "fails AA"}`,
            );
          }
        }
        const applicable = Object.keys(out.apply ?? {});
        if (applicable.length) {
          lines.push(
            "",
            `To make a variant the design: design_write_tokens({patch: apply[label].patch, base_version: ${out.tokens_version ?? "null"}}).`,
            "apply = " + JSON.stringify(out.apply),
          );
        }
        if (out.warnings.length) {
          lines.push("", "WARNINGS — the picture differs from a real browser here:", ...out.warnings.map((w) => `- ${w}`));
        }
        return {
          content: [
            ...out.images.map((image) => ({ type: "image" as const, data: image.png_base64, mimeType: "image/png" })),
            { type: "text", text: lines.join("\n") },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_list_comments",
    "Read operator comments on the rendered design as STRUCTURED TARGETS: which file, which component, which element path, how many routes it affects, plus the instruction itself. Default status 'open'.",
    {
      status: z.enum(["open", "sent", "addressed", "dismissed"]).optional().describe("Default open."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ status, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        return ok(await client.listDesignComments(await resolveDesignProject(client, project), status ?? "open"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "design_resolve_comment",
    "Mark one comment addressed after you actually changed the thing it points at, with a short note of what you did (shown to the operator on the artboard).",
    {
      id: z.string().min(1).describe("Comment id from design_list_comments (cm_… form) — the numeric row id also works."),
      note: z.string().min(4).describe("What you changed to address it."),
      ...designProjectArg,
      ...profileArg,
    },
    async ({ id, note, project, profile }) => {
      try {
        const picked = await clientFor(profile);
        if (!picked.ok) return picked.refusal;
        const { client } = picked;
        const projectId = await resolveDesignProject(client, project);
        // cm_<hex> → numeric row id; bare numbers pass through.
        const rowId = /^cm_[0-9a-f]+$/i.test(id.trim())
          ? parseInt(id.trim().slice(3), 16)
          : Number.parseInt(id, 10);
        if (!Number.isFinite(rowId)) {
          throw new Error(`Unreadable comment id '${id}'.`);
        }
        return ok(await client.resolveDesignComment(projectId, rowId, note));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
