import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative } from "node:path";
import {
  AttachmentDownloadError,
  mediaPathFrom,
  downloadFilenameFrom,
  downloadAttachment,
  type BinaryFetch,
} from "./attachment-download.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tf-dl-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function stubFetch(bytes: Buffer, contentType = "image/png"): BinaryFetch {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

describe("mediaPathFrom", () => {
  it("accepts a bare /media path", () => {
    expect(mediaPathFrom("/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("accepts an absolute url whose path is under /media", () => {
    expect(mediaPathFrom("http://localhost:8000/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("rejects an absolute url to another host", () => {
    expect(() => mediaPathFrom("https://evil.example/media/x")).toThrow(AttachmentDownloadError);
  });

  it("rejects a file:// url", () => {
    expect(() => mediaPathFrom("file:///etc/passwd")).toThrow(AttachmentDownloadError);
  });

  it("rejects a path outside /media", () => {
    expect(() => mediaPathFrom("/api/taskflow/agents/whoami")).toThrow(/media/i);
  });

  it("rejects a traversal escape from /media", () => {
    expect(() => mediaPathFrom("/media/../etc/passwd")).toThrow(AttachmentDownloadError);
  });
});

describe("downloadFilenameFrom", () => {
  it("uses the url basename", () => {
    expect(downloadFilenameFrom("/media/955f66e2-notes.pdf")).toBe("955f66e2-notes.pdf");
  });

  it("strips directory components from an override", () => {
    expect(downloadFilenameFrom("/media/abc-x.bin", "../../evil.sh")).toBe("evil.sh");
  });

  it("strips an absolute path override", () => {
    expect(downloadFilenameFrom("/media/abc-x.bin", "/etc/passwd")).toBe("passwd");
  });

  it("keeps spaces, unicode, ampersands and multiple dots", () => {
    const n = downloadFilenameFrom("/media/abc-my report (v2) & notes.tar.gz");
    expect(n).toBe("abc-my report (v2) & notes.tar.gz");
  });

  it("falls back to a usable name when the basename is empty or dots", () => {
    expect(downloadFilenameFrom("/media/", "..")).toBe("attachment");
    expect(downloadFilenameFrom("/media/", ".")).toBe("attachment");
  });
});

describe("downloadAttachment", () => {
  it("writes the file and reports its metadata", async () => {
    const bytes = Buffer.from("PNGDATA");
    const out = await downloadAttachment({
      url: "/media/abc-diagram.png",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(bytes),
    });

    expect(out.name).toBe("abc-diagram.png");
    expect(out.size_bytes).toBe(bytes.length);
    expect(out.content_type).toBe("image/png");
    expect(await readFile(out.path)).toEqual(bytes);
  });

  it("always writes inside the download dir, even for a hostile override", async () => {
    const out = await downloadAttachment({
      url: "/media/abc-x.bin",
      server: "http://localhost:8000",
      root,
      name: "../../../../etc/passwd",
      fetchImpl: stubFetch(Buffer.from("x")),
    });

    const dir = join(root, ".taskflow", "attachments");
    const rel = relative(dir, out.path);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(dirname(out.path)).toBe(dir);
  });

  it("creates the download dir and a gitignore that excludes everything", async () => {
    await downloadAttachment({
      url: "/media/abc-y.bin",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(Buffer.from("y")),
    });
    expect((await readFile(join(root, ".taskflow", ".gitignore"), "utf8")).trim()).toBe("*");
  });

  it("throws on a non-2xx response and writes nothing", async () => {
    const failing: BinaryFetch = async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(
      downloadAttachment({
        url: "/media/abc-missing.bin",
        server: "http://localhost:8000",
        root,
        fetchImpl: failing,
      }),
    ).rejects.toThrow(/404/);
  });

  it("defaults content_type when the response omits it", async () => {
    const out = await downloadAttachment({
      url: "/media/abc-z.bin",
      server: "http://localhost:8000",
      root,
      fetchImpl: stubFetch(Buffer.from("z"), ""),
    });
    expect(out.content_type).toBe("application/octet-stream");
  });
});
