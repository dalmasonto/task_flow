/**
 * A small typed HTTP client for the TaskFlow backend's agent-authed API.
 *
 * One method per endpoint in the agent surface (Stages 1–6). Every request is
 * authenticated with the profile key via `Authorization: Agent <key>`; the base
 * URL is the resolved profile's `server`. A non-2xx response is turned into a
 * thrown {@link TaskflowApiError} carrying the backend's `detail`/text so the
 * MCP tool (or hook) surfaces a real reason, never a bare status.
 *
 * `fetchImpl` is injectable so the client can be unit-tested against a stub
 * without a live backend.
 */

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
}>;

export interface TaskflowClientOptions {
  /** Base server URL, e.g. `http://localhost:8000` (trailing slash trimmed). */
  server: string;
  /** The profile's raw `tfk_…` key. */
  key: string;
  /** Injectable fetch (defaults to the global `fetch`). */
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
}

/** An error carrying the backend's status + parsed detail. */
export class TaskflowApiError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, detail: string) {
    super(`${method} ${path} → ${status}: ${detail}`);
    this.name = "TaskflowApiError";
    this.status = status;
    this.detail = detail;
    this.method = method;
    this.path = path;
  }
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

const API_PREFIX = "/api/taskflow";

// ---- Endpoint payload / response shapes (only the fields the client asserts) ----

export interface Whoami {
  agent_id: number;
  display_name: string;
  identifier: string;
  project: number;
  status: string;
}

export interface ChannelSummary {
  id: number;
  title: string;
  kind: string;
  topic: string | null;
}

export interface AgentSummary {
  id: number;
  display_name: string;
  identifier: string;
  status: string;
  last_seen_at: string | null;
}

export interface MessagesPage {
  messages: unknown[];
  read_cursor: number | null;
}

export interface SessionRow {
  id: number;
  session_identifier: string;
  status: string;
  [key: string]: unknown;
}

export interface SendMessageInput {
  channel: number;
  body_markdown: string;
  priority?: string;
  client_nonce?: string;
}

export interface CreateTaskInput {
  title: string;
  description_markdown?: string;
  priority?: string;
  notes_markdown?: string;
  claim?: boolean;
}

export interface RegisterSessionInput {
  session_identifier: string;
  host?: string;
  pid?: number;
  cwd?: string;
  transport?: string;
}

export interface FrameInput {
  content: string;
  stream?: string;
  task?: number;
}

export interface ActivityEventInput {
  action: string;
  body_markdown?: string;
  metadata_json?: string;
  task?: number;
}

export class TaskflowClient {
  private readonly server: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: TaskflowClientOptions) {
    this.server = options.server.replace(/\/+$/, "");
    this.key = options.key;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const impl = options.fetchImpl ?? globalFetch;
    if (!impl) {
      throw new Error("No fetch implementation available (Node >=18 or pass fetchImpl).");
    }
    this.fetchImpl = impl;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  // ---- core request helper -------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    let url = `${this.server}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Agent ${this.key}`,
      Accept: "application/json",
    };
    const init: Parameters<FetchLike>[1] = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init!.body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    init!.signal = controller.signal;

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new TaskflowApiError(method, path, 0, `network error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text();
    if (!res.ok) {
      throw new TaskflowApiError(method, path, res.status, extractDetail(raw, res.statusText));
    }
    if (!raw) {
      return undefined as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A 2xx with a non-JSON body (e.g. the health string) — hand it back raw.
      return raw as unknown as T;
    }
  }

  // ---- READS ---------------------------------------------------------------

  /** `GET /agents/whoami` — the identity behind the presented credential. */
  whoami(): Promise<Whoami> {
    return this.request("GET", `${API_PREFIX}/agents/whoami`);
  }

  /** `GET /agents/tasks?status=&assigned=` — tasks in the agent's project. */
  listTasks(params: { status?: string; assigned?: string } = {}): Promise<unknown[]> {
    return this.request("GET", `${API_PREFIX}/agents/tasks`, {
      query: { status: params.status, assigned: params.assigned },
    });
  }

  /** `GET /agents/channels` — channels the agent may see. */
  listChannels(): Promise<ChannelSummary[]> {
    return this.request("GET", `${API_PREFIX}/agents/channels`);
  }

  /** `GET /agents/agents` — the other agents in the caller's project. */
  listAgents(): Promise<AgentSummary[]> {
    return this.request("GET", `${API_PREFIX}/agents/agents`);
  }

  /** `GET /agents/messages?channel=&since=&limit=` → `{ messages, read_cursor }`. */
  listMessages(params: {
    channel: number;
    since?: number;
    limit?: number;
  }): Promise<MessagesPage> {
    return this.request("GET", `${API_PREFIX}/agents/messages`, {
      query: { channel: params.channel, since: params.since, limit: params.limit },
    });
  }

  /** `GET /agents/activity?task=&limit=` — recent activity, newest first. */
  listActivity(params: { task?: number; limit?: number } = {}): Promise<unknown[]> {
    return this.request("GET", `${API_PREFIX}/agents/activity`, {
      query: { task: params.task, limit: params.limit },
    });
  }

  // ---- WRITES: messages / read cursor --------------------------------------

  /** `POST /agents/agent/messages` — speak as this agent in a channel. */
  sendMessage(input: SendMessageInput): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/agent/messages`, { body: input });
  }

  /** `POST /channels/{id}/agent/read` — advance this agent's read cursor. */
  markRead(channel: number, lastReadMessage: number): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/channels/${channel}/agent/read`, {
      body: { last_read_message: lastReadMessage },
    });
  }

  // ---- WRITES: tasks -------------------------------------------------------

  /** `POST /agents/tasks` — author a task in the agent's project (optionally claim). */
  createTask(input: CreateTaskInput): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/tasks`, { body: input });
  }

  /** `POST /agents/tasks/{id}/status` — advance a task's status. */
  updateTaskStatus(task: number, status: string): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/tasks/${task}/status`, {
      body: { status },
    });
  }

  /** `POST /agents/tasks/{id}/claim` — self-assign a task. */
  claimTask(task: number): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/tasks/${task}/claim`, { body: {} });
  }

  /** `POST /tasks/{id}/agent/review` — record a review verdict as this agent. */
  reportReview(task: number, decision: string, bodyMarkdown?: string): Promise<unknown> {
    const body: { decision: string; body_markdown?: string } = { decision };
    if (bodyMarkdown !== undefined) body.body_markdown = bodyMarkdown;
    return this.request("POST", `${API_PREFIX}/tasks/${task}/agent/review`, { body });
  }

  // ---- WRITES: sessions / frames / activity --------------------------------

  /** `POST /agents/sessions` — register or reconnect a live session. */
  registerSession(input: RegisterSessionInput): Promise<SessionRow> {
    return this.request("POST", `${API_PREFIX}/agents/sessions`, { body: input });
  }

  /** `POST /agents/sessions/{id}/heartbeat` — bump liveness (status hint idle/busy). */
  heartbeat(session: number, status?: string): Promise<SessionRow> {
    const body: { status?: string } = {};
    if (status !== undefined) body.status = status;
    return this.request("POST", `${API_PREFIX}/agents/sessions/${session}/heartbeat`, { body });
  }

  /** `POST /agents/sessions/{id}/frames` — append one terminal frame. */
  appendFrame(session: number, frame: FrameInput): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/sessions/${session}/frames`, {
      body: frame,
    });
  }

  /** `POST /agents/sessions/{id}/frames` — append a batch of terminal frames. */
  appendFrames(session: number, frames: FrameInput[]): Promise<unknown> {
    return this.request("POST", `${API_PREFIX}/agents/sessions/${session}/frames`, {
      body: { frames },
    });
  }

  /** `POST /agents/sessions/{id}/close` — disconnect a session. */
  closeSession(session: number): Promise<SessionRow> {
    return this.request("POST", `${API_PREFIX}/agents/sessions/${session}/close`, { body: {} });
  }

  /** `POST /agents/activity` — log one real activity event. */
  logActivity(event: ActivityEventInput): Promise<{ created: number }> {
    return this.request("POST", `${API_PREFIX}/agents/activity`, { body: event });
  }

  /** `POST /agents/activity` — log a batch of activity events. */
  logActivityBatch(events: ActivityEventInput[]): Promise<{ created: number }> {
    return this.request("POST", `${API_PREFIX}/agents/activity`, { body: { events } });
  }
}

/**
 * Pull a human message out of an error response body: prefer a JSON `detail`
 * (the backend's convention) or `error`, else the raw text, else the status
 * line. Kept resilient — a malformed body must never mask the real failure.
 */
export function extractDetail(raw: string, statusText: string): string {
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.detail === "string") return parsed.detail;
      if (typeof parsed.error === "string") return parsed.error;
      // Field-error envelope (e.g. { user: ["…"] }) — surface the first message.
      for (const value of Object.values(parsed)) {
        if (Array.isArray(value) && typeof value[0] === "string") return value[0];
      }
      return trimmed;
    } catch {
      return trimmed;
    }
  }
  return statusText || "request failed";
}
