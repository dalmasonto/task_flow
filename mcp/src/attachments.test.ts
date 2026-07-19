import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, AttachmentError, resolveAttachments } from "./attachments.js";

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "tf-attach-"));
  root = join(base, "project");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, "planning"), { recursive: true });
  await writeFile(join(root, "planning", "spec.md"), "# spec\n");
  await writeFile(join(outside, "secret.txt"), "SECRET\n");
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  // A sibling directory sharing the root's name as a string prefix.
  await mkdir(`${root}_evil`, { recursive: true });
  await writeFile(join(`${root}_evil`, "evil.txt"), "EVIL\n");
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
  await rm(`${root}_evil`, { recursive: true, force: true });
});

describe("resolveAttachments", () => {
  it("reads a relative path inside the root", async () => {
    const out = await resolveAttachments(["planning/spec.md"], root);
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe("spec.md");
    expect(out[0].bytes.toString()).toBe("# spec\n");
  });

  it("accepts an absolute path inside the root", async () => {
    const out = await resolveAttachments([join(root, "planning", "spec.md")], root);
    expect(out[0].filename).toBe("spec.md");
  });

  it("resolves relative paths against the root, not process.cwd()", async () => {
    const out = await resolveAttachments(["planning/spec.md"], root);
    expect(out[0].bytes.toString()).toBe("# spec\n");
  });

  it("rejects path traversal", async () => {
    await expect(resolveAttachments(["../outside/secret.txt"], root)).rejects.toThrow(
      AttachmentError,
    );
  });

  it("rejects a symlink escaping the root", async () => {
    await expect(resolveAttachments(["escape.txt"], root)).rejects.toThrow(/outside the project/i);
  });

  it("rejects a sibling directory sharing the root's name prefix", async () => {
    await expect(
      resolveAttachments([join(`${root}_evil`, "evil.txt")], root),
    ).rejects.toThrow(/outside the project/i);
  });

  it("rejects a missing file", async () => {
    await expect(resolveAttachments(["nope.md"], root)).rejects.toThrow(/not found/i);
  });

  it("rejects a directory", async () => {
    await expect(resolveAttachments(["planning"], root)).rejects.toThrow(/not a file/i);
  });

  it("rejects an oversize file", async () => {
    const big = join(root, "big.bin");
    await writeFile(big, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(resolveAttachments(["big.bin"], root)).rejects.toThrow(/25MB/);
    await rm(big, { force: true });
  });

  it("is all-or-nothing: one bad path yields nothing", async () => {
    await expect(
      resolveAttachments(["planning/spec.md", "nope.md"], root),
    ).rejects.toThrow(/not found/i);
  });
});
