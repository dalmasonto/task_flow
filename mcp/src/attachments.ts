/**
 * Resolve local file paths into message attachments.
 *
 * An attachment becomes a fetchable URL once uploaded, so an unrestricted path
 * parameter would turn one bad instruction into an exfiltration channel. Every
 * path is therefore confined to the project root — the directory holding
 * `.taskflow.json` — and validated fully before any upload begins.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** Mirrors `MAX_ATTACHMENT_BYTES` in the backend (views.rs). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

export interface Attachment {
  filename: string;
  bytes: Buffer;
}

/**
 * True when `candidate` is inside `root`.
 *
 * Uses `path.relative` rather than a string prefix test: `startsWith` would let
 * `<root>_evil` pass, since it shares the root's characters without being under
 * it. Both arguments must already be real (symlink-resolved) paths.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * Validate and read every path, or throw. Nothing is returned unless all paths
 * pass — a partially-attached message is worse than none, because the reader
 * sees text citing a file that never arrived.
 */
export async function resolveAttachments(
  paths: string[],
  root: string,
): Promise<Attachment[]> {
  const realRoot = await realpath(root);
  const out: Attachment[] = [];

  for (const input of paths) {
    // Relative paths resolve against the project root, never process.cwd():
    // a stdio MCP server inherits the client's cwd, which need not match.
    const absolute = isAbsolute(input) ? input : resolve(realRoot, input);

    // realpath BEFORE the containment check — a symlink inside the root that
    // points outside it would pass a check made on the unresolved path.
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw new AttachmentError(`Attachment not found: ${input}`);
    }

    if (!isInside(realRoot, real)) {
      throw new AttachmentError(
        `Attachment is outside the project root: ${input} (resolved to ${real})`,
      );
    }

    const info = await stat(real);
    if (!info.isFile()) {
      throw new AttachmentError(`Attachment is not a file: ${input}`);
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      const mb = (info.size / (1024 * 1024)).toFixed(1);
      throw new AttachmentError(
        `Attachment "${input}" is ${mb}MB; the maximum attachment size is 25MB.`,
      );
    }

    out.push({ filename: basename(real), bytes: await readFile(real) });
  }

  return out;
}
