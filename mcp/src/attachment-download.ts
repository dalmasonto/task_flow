/**
 * Download a message attachment to disk.
 *
 * The tool exists as insulation, not as an authorization point. `/media` is
 * currently served without auth; when storage is gated at the framework level,
 * only this module changes — it starts sending the agent key as a header — and
 * the agent-facing contract (url in, path out) stays put.
 *
 * Two untrusted inputs: the `url` (must resolve under `/media/`, or this
 * becomes an arbitrary-URL fetcher with a disk write attached) and the
 * filename (must not escape the download directory).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export class AttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentDownloadError";
  }
}

export interface DownloadResult {
  path: string;
  name: string;
  size_bytes: number;
  content_type: string;
}

export type BinaryFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const MEDIA_PREFIX = "/media/";

/**
 * Validate an attachment url and reduce it to its `/media/...` path.
 *
 * Absolute urls are accepted only for their path — the host is discarded
 * before the fetch (it always targets the configured server, never the url's
 * own host), so a url pointing at another origin can never redirect the
 * fetch there. `server` is free-form user config (any origin, not just
 * loopback), so instead of a hardcoded allowlist, an absolute url's origin is
 * compared against the *configured* server's origin: a match is accepted,
 * anything else is a sign of a confused or hostile caller and is refused
 * outright. When no `server` is given (e.g. validating a url in isolation),
 * there is nothing to compare against, so the host is simply discarded and
 * only the path is used — safe, since it is never fetched.
 *
 * The path is percent-decoded before normalisation so a bare `/media/...`
 * input and an absolute-url input agree on what `%2e%2e`-style traversal
 * resolves to. Anything that does not land under `/media/` after
 * normalisation is rejected.
 */
export function mediaPathFrom(url: string, server?: string): string {
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AttachmentDownloadError(`Not a valid attachment url: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AttachmentDownloadError(
        `Attachment url must be http(s) or a /media path, got: ${url}`,
      );
    }
    // The host is discarded below regardless -- the actual fetch always goes
    // to the configured server, never to whatever host this url names. But an
    // absolute url naming some OTHER host than the configured server is still
    // a sign of a confused or hostile caller, so it is rejected outright
    // rather than silently tolerated.
    if (server) {
      let serverOrigin: string;
      try {
        serverOrigin = new URL(server).origin;
      } catch {
        throw new AttachmentDownloadError(`Not a valid server origin: ${server}`);
      }
      if (parsed.origin !== serverOrigin) {
        throw new AttachmentDownloadError(
          `Attachment url points at another host, got: ${url}`,
        );
      }
    }
    path = parsed.pathname;
  } else {
    path = url;
  }

  // Percent-decode before normalising, so `/media/%2e%2e/etc/passwd` collapses
  // the same way whether it arrived as a bare path or inside an absolute url.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    throw new AttachmentDownloadError(`Not a valid attachment url: ${url}`);
  }

  // Normalise so `/media/../etc/passwd` cannot masquerade as a media path.
  const normalised = resolve("/", decodedPath);
  if (!normalised.startsWith(MEDIA_PREFIX)) {
    throw new AttachmentDownloadError(
      `Attachment url must be under ${MEDIA_PREFIX} — got: ${url}`,
    );
  }
  return normalised;
}

/**
 * The filename to write, always a bare basename.
 *
 * Storage keys are already UUID-prefixed, so the url basename is unique by
 * construction and needs no extra prefix. An override is accepted for a
 * friendlier name, but is reduced to its basename first.
 */
export function downloadFilenameFrom(mediaPath: string, override?: string): string {
  const raw = override && override.trim() ? override : mediaPath;
  const name = basename(raw.replace(/[/\\]+$/, ""));
  if (!name || name === "." || name === "..") return "attachment";
  return name;
}

/** Absolute path of the download directory for a project root. */
export function downloadDirFor(root: string): string {
  return join(root, ".taskflow", "attachments");
}

export async function downloadAttachment(opts: {
  url: string;
  server: string;
  root: string;
  name?: string;
  key?: string;
  fetchImpl?: BinaryFetch;
}): Promise<DownloadResult> {
  const mediaPath = mediaPathFrom(opts.url, opts.server);
  const filename = downloadFilenameFrom(mediaPath, opts.name);

  const dir = downloadDirFor(opts.root);
  const target = resolve(dir, filename);

  // Belt and braces: the basename reduction above should make escape
  // impossible, so this asserts the invariant rather than trusting it.
  const rel = relative(dir, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new AttachmentDownloadError(
      `Refusing to write outside the download directory: ${filename}`,
    );
  }

  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as BinaryFetch);
  const absolute = `${opts.server.replace(/\/$/, "")}${mediaPath}`;

  // When storage is gated at the framework level, the auth header goes HERE and
  // nothing else in the system needs to change.
  const headers: Record<string, string> = {};
  if (opts.key) headers.Authorization = `Agent ${opts.key}`;

  const res = await doFetch(absolute, { headers });
  if (!res.ok) {
    throw new AttachmentDownloadError(
      `Download failed: ${res.status} ${res.statusText} for ${mediaPath}`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(dir, { recursive: true });
  // Downloads are scratch, never committed.
  await writeFile(join(opts.root, ".taskflow", ".gitignore"), "*\n");
  await writeFile(target, bytes);

  return {
    path: target,
    name: filename,
    size_bytes: bytes.length,
    content_type: res.headers.get("content-type") || "application/octet-stream",
  };
}
