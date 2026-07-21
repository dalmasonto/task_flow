/**
 * Turn an id-only realtime message event into the message itself.
 *
 * ## Why this exists
 *
 * Chat rows are CHANNEL-scoped but the realtime group is per-PROJECT, so
 * anything projected onto the wire reaches every member of the project. That is
 * why chat events carry the row id and nothing else — projecting the fields
 * broadcast every DM's body, roster and attachment key to the whole project
 * (`backend/tests/realtime_dm_privacy.rs`).
 *
 * The id alone is safe to broadcast and useless without authorization: the
 * message is fetched back over the agent read API, which re-checks the channel
 * roster. An agent that is not on the channel resolves nothing.
 *
 * The event carries no channel either, so the lookup fans out across the
 * channels this agent is on — the same shape `check_messages` already uses. That
 * roster is small (a project room plus a handful of DMs), and the per-channel
 * fetch is a one-row window rather than a page.
 */

import type { MessageTarget } from "./events.js";

/** A message as the agent read API returns it. */
export interface ResolvedMessage {
  id: number;
  channel: number;
  sender_kind: string;
  sender_label: string;
  body_markdown: string;
  sender_agent: number | null;
  /** Present on the read row (the backend serializes them); the agent notice
   *  surfaces them so a delivered message carries its own context. */
  project?: number | null;
  task?: number | null;
  sender_user?: number | null;
  /** #29: the one agent a directed group message is for; null = broadcast. */
  target_agent?: number | null;
  /** #29: the full directed-target set (agents + users). The backend stores it
   *  as a JSON STRING column, so the read row carries a string here; this module
   *  parses it into an array before delivery. Supersedes `target_agent`. */
  targets?: MessageTarget[];
  attachments?: Array<{ name: string; size_bytes: number; url: string }>;
}

/** Parse the message's `targets` column — a JSON string like
 *  `[{"kind":"agent","id":1}]` on the read row — into a validated array.
 *  Anything malformed (bad JSON, wrong shape) degrades to undefined, i.e. a
 *  broadcast, rather than throwing on the delivery path. */
export function parseTargets(raw: unknown): MessageTarget[] | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value)) return undefined;
  const out: MessageTarget[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const kind = (entry as Record<string, unknown>).kind;
      const id = (entry as Record<string, unknown>).id;
      if (typeof kind === "string" && typeof id === "number") out.push({ kind, id });
    }
  }
  return out.length ? out : undefined;
}

/** The slice of the client this module needs; narrowed so tests need no HTTP. */
export interface MessageSource {
  listChannels(): Promise<Array<{ id: number }>>;
  listMessages(params: {
    channel: number;
    since?: number;
    limit?: number;
  }): Promise<{ messages: ResolvedMessage[] }>;
}

/**
 * Fetch message `id`, or `null` when this agent cannot see it.
 *
 * Never throws. A failure to resolve must degrade to "nothing delivered" — the
 * message is still stored and `check_messages` will surface it — rather than
 * taking down the event stream that carries every other message.
 */
export async function resolveMessage(
  source: MessageSource,
  id: number,
): Promise<ResolvedMessage | null> {
  let channels: Array<{ id: number }>;
  try {
    channels = await source.listChannels();
  } catch {
    return null;
  }

  const found = await Promise.all(
    channels.map(async (channel) => {
      try {
        // `since` is exclusive, so `id - 1` asks for exactly this row onward and
        // `limit: 1` keeps it to one. A per-event page fetch would be wasteful on
        // a busy project.
        const page = await source.listMessages({ channel: channel.id, since: id - 1, limit: 1 });
        // The window can return a NEIGHBOURING row when this id is not in that
        // channel, so match the id explicitly — delivering the wrong message
        // would be worse than delivering none.
        return page.messages.find((m) => m.id === id) ?? null;
      } catch {
        // One unreachable channel must not hide a message sitting in another.
        return null;
      }
    }),
  );

  const message = found.find((m): m is ResolvedMessage => m !== null) ?? null;
  // The read row carries `targets` as a JSON string; parse it to the array
  // `shouldDeliver` gates on. Done here so both the live push and the reconnect
  // catch-up (which resolve through this function) see the same parsed shape.
  if (message) message.targets = parseTargets((message as { targets?: unknown }).targets);
  return message;
}
