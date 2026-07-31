import { describe, it, expect, afterEach } from "vitest";
import { normalizeSnapshot, sanitizeForPane, buildNotice, detectTmuxPane } from "./tmux.js";

describe("normalizeSnapshot", () => {
  // A TUI pads the screen to its full height. Keeping that padding would make
  // every capture differ on cursor movement alone, defeating the change-detection
  // that keeps an idle agent from writing a frame every tick.
  it("drops trailing blank lines so an idle screen compares equal", () => {
    const a = normalizeSnapshot("$ ls\nfile.txt\n\n\n\n");
    const b = normalizeSnapshot("$ ls\nfile.txt\n\n");
    expect(a).toBe("$ ls\nfile.txt");
    expect(a).toBe(b);
  });

  it("keeps interior blank lines", () => {
    expect(normalizeSnapshot("a\n\nb\n")).toBe("a\n\nb");
  });

  it("keeps the TAIL when oversized — the bottom is the live part", () => {
    const out = normalizeSnapshot("old-content\n" + "x".repeat(50) + "NEWEST", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("NEWEST")).toBe(true);
    expect(out).not.toContain("old-content");
  });

  it("leaves a normal screen untouched", () => {
    expect(normalizeSnapshot("bash-5.1$ echo hi\nhi", 1000)).toBe("bash-5.1$ echo hi\nhi");
  });
});

describe("sanitizeForPane", () => {
  // The whole point: a newline would SUBMIT the agent's prompt early, turning a
  // notice into an unintended instruction. Nothing typed into a live pane may
  // carry control characters.
  it("strips newlines and carriage returns", () => {
    expect(sanitizeForPane("hello\nworld\r\nagain")).toBe("hello world again");
  });

  it("strips ESC so a notice cannot rewrite the pane", () => {
    expect(sanitizeForPane("safe\u001b[2Jwiped")).toBe("safe wiped");
  });

  it("strips C1 controls and DEL too", () => {
    expect(sanitizeForPane("a\u0000b\u007fc\u009dd")).toBe("a b c d");
  });

  it("truncates so a huge body cannot flood the prompt", () => {
    const out = sanitizeForPane("x".repeat(500), 50);
    expect(out).toHaveLength(50);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});

describe("buildNotice", () => {
  // Composed locally from COUNTS. If message bodies ever leaked in here, a
  // channel post would become a way to type arbitrary text into a live agent.
  it("carries counts and the mark_read instruction, never message content", () => {
    const notice = buildNotice(3, 2);
    expect(notice).toContain("3 unread messages");
    expect(notice).toContain("2 channels");
    expect(notice).toContain("mark_read");
  });

  it("reads naturally for a single message in one channel", () => {
    expect(buildNotice(1, 1)).toContain("1 unread message in a channel");
  });

  it("is always a single line", () => {
    expect(buildNotice(9, 4)).not.toMatch(/[\r\n]/);
  });
});

describe("detectTmuxPane", () => {
  const original = process.env.TMUX_PANE;
  afterEach(() => {
    if (original === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = original;
  });

  // The point of the whole feature: the pane is discovered, never configured.
  it("uses $TMUX_PANE when tmux exported it", async () => {
    process.env.TMUX_PANE = "%7";
    expect(await detectTmuxPane()).toBe("%7");
  });

  it("ignores a blank $TMUX_PANE rather than returning empty string", async () => {
    process.env.TMUX_PANE = "   ";
    // Falls through to tty matching; outside tmux that yields null, and inside a
    // real pane it yields that pane — either way, never "".
    expect(await detectTmuxPane()).not.toBe("");
  });
});

import { sendKeySequence } from "./tmux.js";

describe("sendKeySequence", () => {
  // The multi-select bug: keys fired back to back sometimes dropped the middle
  // ones because the TUI was still re-rendering. A pause between keys lets it
  // settle. Observed non-deterministically: [1,2,3,4] recorded as {1,4} once and
  // {1,2,3,4} another time from identical input.
  it("sends every key, in order", async () => {
    const sent: string[] = [];
    await sendKeySequence(["1", "2", "3", "Right", "1", "Enter"], "%0", {
      sendKey: async (k) => void sent.push(k),
      sleep: async () => {},
    });
    expect(sent).toEqual(["1", "2", "3", "Right", "1", "Enter"]);
  });

  it("pauses BETWEEN keys, not after the last", async () => {
    const sleeps: number[] = [];
    await sendKeySequence(["1", "2", "3"], "%0", {
      sendKey: async () => {},
      sleep: async (ms) => void sleeps.push(ms),
    });
    // Three keys -> two gaps.
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("does not pause for a single key", async () => {
    const sleeps: number[] = [];
    await sendKeySequence(["Enter"], "%0", {
      sendKey: async () => {},
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toHaveLength(0);
  });

  it("sends nothing for an empty sequence", async () => {
    const sent: string[] = [];
    await sendKeySequence([], "%0", { sendKey: async (k) => void sent.push(k), sleep: async () => {} });
    expect(sent).toEqual([]);
  });
});

import { notifyPane, SUBMIT_ENTER_DELAY_MS, SUBMIT_ENTER_RETRIES_MS } from "./tmux.js";

describe("notifyPane submit pacing", () => {
  // #108: Codex's composer treats a CR arriving in the same input burst as the
  // typed text as a PASTED newline, not a submit — the notice sat in the
  // composer until a human pressed Enter. And for a LARGE notice the composer
  // collapses the burst into a paste chip that CONSUMES the first Enter no
  // matter how late it lands — only a REPEATED Enter after the paste settles
  // submits. So: type, pause, Enter, then re-press Enter on the retry
  // schedule. Extra Enters are no-ops once submitted (empty composer /
  // running turn), verified live on Codex 0.139 + 0.146 and Claude Code.
  it("types, pauses, presses Enter, then re-presses on the retry schedule", async () => {
    const log: string[] = [];
    await notifyPane("hello agent", "%7", true, {
      exec: async (args) => void log.push(args.join(" ")),
      sleep: async (ms) => void log.push(`sleep:${ms}`),
    });
    expect(log).toEqual([
      "send-keys -t %7 -l hello agent",
      `sleep:${SUBMIT_ENTER_DELAY_MS}`,
      "send-keys -t %7 Enter",
      ...SUBMIT_ENTER_RETRIES_MS.flatMap((ms) => [`sleep:${ms}`, "send-keys -t %7 Enter"]),
    ]);
    expect(SUBMIT_ENTER_DELAY_MS).toBeGreaterThanOrEqual(100);
    // The whole point of round two: at least one retry press exists, and it
    // waits long enough for the paste chip to settle.
    expect(SUBMIT_ENTER_RETRIES_MS.length).toBeGreaterThanOrEqual(1);
    expect(SUBMIT_ENTER_RETRIES_MS[0]).toBeGreaterThanOrEqual(500);
  });

  it("does not pause (or press Enter) for a status-line notice", async () => {
    const log: string[] = [];
    await notifyPane("fyi", "%7", false, {
      exec: async (args) => void log.push(args.join(" ")),
      sleep: async (ms) => void log.push(`sleep:${ms}`),
    });
    expect(log).toEqual(["display-message -t %7 fyi"]);
  });
});

import { sendKeySteps } from "./tmux.js";

describe("sendKeySteps", () => {
  it("presses keys and types text in order, paced", async () => {
    const log: string[] = [];
    await sendKeySteps(
      [{ key: "Enter" }, { text: "hello" }, { key: "1" }],
      "%0",
      { sendKey: async (k) => void log.push(`key:${k}`), typeText: async (t) => void log.push(`text:${t}`), sleep: async () => {} },
    );
    expect(log).toEqual(["key:Enter", "text:hello", "key:1"]);
  });

  // A text field must MOUNT and FOCUS when the caret lands on it, which a
  // checkbox never does — so a text step needs a longer settle than the plain
  // 90ms inter-key gap, both before (let the field focus) and after (let the
  // value register before the next key). Live test showed a 90ms-only gap
  // dropped the typed text entirely. The settle is interleaved as a sleep of
  // its own, so it shows up as an extra, longer pause bracketing the text.
  it("settles longer around a text step than between plain keys", async () => {
    const sleeps: number[] = [];
    await sendKeySteps(
      [{ key: "Down" }, { text: "hi" }, { key: "Enter" }],
      "%0",
      { sendKey: async () => {}, typeText: async () => {}, sleep: async (ms) => void sleeps.push(ms) },
    );
    // Every gap that brackets the text step must exceed the plain inter-key gap.
    const plain = 90;
    const longGaps = sleeps.filter((ms) => ms > plain);
    expect(longGaps.length).toBeGreaterThanOrEqual(2); // before AND after the text
  });
});
