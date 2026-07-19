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

type RecordingFetch = BinaryFetch & {
  calls: { url: string; init?: { headers?: Record<string, string> } }[];
};

function stubFetch(bytes: Buffer, contentType = "image/png"): RecordingFetch {
  const calls: RecordingFetch["calls"] = [];
  const impl = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }) as RecordingFetch;
  impl.calls = calls;
  return impl;
}

describe("mediaPathFrom", () => {
  it("accepts a bare /media path", () => {
    expect(mediaPathFrom("/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("accepts an absolute url whose path is under /media", () => {
    expect(mediaPathFrom("http://localhost:8000/media/abc-notes.pdf")).toBe("/media/abc-notes.pdf");
  });

  it("rejects an absolute url to another host", () => {
    expect(() =>
      mediaPathFrom("https://evil.example/media/x", "http://localhost:8000"),
    ).toThrow(AttachmentDownloadError);
  });

  it("accepts an absolute url matching the configured origin", () => {
    expect(
      mediaPathFrom("http://localhost:8000/media/abc-notes.pdf", "http://localhost:8000"),
    ).toBe("/media/abc-notes.pdf");
  });

  it("accepts a non-localhost configured server whose origin matches", () => {
    expect(
      mediaPathFrom(
        "http://192.168.1.50:8000/media/abc-notes.pdf",
        "http://192.168.1.50:8000",
      ),
    ).toBe("/media/abc-notes.pdf");
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

  it("rejects a percent-encoded traversal escape the same as a literal one", () => {
    expect(() => mediaPathFrom("/media/%2e%2e/etc/passwd")).toThrow(AttachmentDownloadError);
  });

  it("rejects a DOUBLE-encoded traversal escape too", () => {
    // One decode pass leaves the literal `%2e%2e`, which would sail through.
    expect(() => mediaPathFrom("/media/%252e%252e/etc/passwd")).toThrow(
      AttachmentDownloadError,
    );
  });

  it("does not reject a key containing a literal percent sign", () => {
    // The backend emits urls unencoded, so `%` is a legal key character and
    // `decodeURIComponent` throwing on it must not be fatal.
    expect(mediaPathFrom("/media/uuid-50%.png")).toBe("/media/uuid-50%.png");
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

  it("fetches the configured server plus the media path, not the raw url", async () => {
    const fetchImpl = stubFetch(Buffer.from("PNGDATA"));
    await downloadAttachment({
      url: "/media/abc-x.png",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    expect(fetchImpl.calls.map((c) => c.url)).toEqual(["http://localhost:8000/media/abc-x.png"]);
  });

  it("builds the fetch target from server + path even for an absolute-url input", async () => {
    const fetchImpl = stubFetch(Buffer.from("PNGDATA"));
    await downloadAttachment({
      url: "http://localhost:8000/media/abc-x.png",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    expect(fetchImpl.calls.map((c) => c.url)).toEqual(["http://localhost:8000/media/abc-x.png"]);
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

  // -------------------------------------------------------------------------
  // URL ENCODING. The backend emits attachment urls UNENCODED (see the
  // contract-pair test
  // `agent_read_emits_the_url_unencoded_for_a_name_with_a_space_and_a_hash` in
  // backend/plugins/taskflow-agents/tests/message_attachments.rs — THESE MUST
  // MOVE TOGETHER). So this side must re-encode before fetching, or a key with
  // a `#` or `?` truncates the request and 404s on a file that exists.
  // -------------------------------------------------------------------------

  it("downloads a backend-shaped url whose key has a space and a #", async () => {
    // This literal is the exact shape the Rust contract-pair test pins.
    const fetchImpl = stubFetch(Buffer.from("PDFDATA"), "application/pdf");
    const out = await downloadAttachment({
      url: "/media/955f66e2-Q3 #2 report.pdf",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    const [target] = fetchImpl.calls.map((c) => c.url);
    expect(target).toBe(
      "http://localhost:8000/media/955f66e2-Q3%20%232%20report.pdf",
    );
    // Nothing was lost at the fragment delimiter.
    expect(target).not.toContain("#");
    expect(target.endsWith("report.pdf")).toBe(true);

    // And the file lands on disk under its real, decoded name.
    expect(out.name).toBe("955f66e2-Q3 #2 report.pdf");
    expect(await readFile(out.path)).toEqual(Buffer.from("PDFDATA"));
  });

  it("encodes a ? in the key instead of starting a query string", async () => {
    const fetchImpl = stubFetch(Buffer.from("PNGDATA"));
    await downloadAttachment({
      url: "/media/uuid-a?b.png",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    const [target] = fetchImpl.calls.map((c) => c.url);
    expect(target).toBe("http://localhost:8000/media/uuid-a%3Fb.png");
    expect(target).not.toContain("?");
  });

  it("handles a literal % in the key without throwing", async () => {
    const fetchImpl = stubFetch(Buffer.from("PNGDATA"));
    const out = await downloadAttachment({
      url: "/media/uuid-50%.png",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      "http://localhost:8000/media/uuid-50%25.png",
    ]);
    expect(out.name).toBe("uuid-50%.png");
  });

  it("leaves / separators in the media path unencoded", async () => {
    const fetchImpl = stubFetch(Buffer.from("PNGDATA"));
    await downloadAttachment({
      url: "/media/2026/07/uuid-x y.png",
      server: "http://localhost:8000",
      root,
      fetchImpl,
    });

    const [target] = fetchImpl.calls.map((c) => c.url);
    expect(target).toBe("http://localhost:8000/media/2026/07/uuid-x%20y.png");
    expect(target).not.toContain("%2F");
    expect(target).not.toContain("%2f");
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
