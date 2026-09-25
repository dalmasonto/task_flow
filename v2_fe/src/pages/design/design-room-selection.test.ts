import { describe, expect, it } from "vitest"

// `?raw` rather than `node:fs`: the test tsconfig exposes `vite/client` and not
// `node`, and reading through Vite's own resolver means a moved or renamed file
// breaks loudly here instead of quietly reading the wrong path.
import agentsPage from "../agents.tsx?raw"
import dock from "../../components/chat/chat-dock.tsx?raw"
import designSurface from "./DesignSurfacePage.tsx?raw"

// A SOURCE-LEVEL assertion, and why it is the right tool here rather than a
// smell.
//
// Which room each surface opens is decided inside a `useEffect` or a `useMemo` in
// a component. This repo has no jsdom and no Testing Library, and
// `renderToStaticMarkup` — the trick `chat-dock.test.ts` uses for the dock's
// markup — does NOT run effects. So the one behaviour standing between the user
// and an empty design page is the behaviour no test in this repo can execute:
// reverting either page to a title or an index passed the entire suite (640/640,
// measured, not assumed).
//
// The precedent is one layer down and the argument is identical: Task 1's
// `backend/plugins/taskflow-agents/tests/design_room.rs` reads the migration file
// off disk because "tests never apply migrations, so nothing else here would
// notice a missing or malformed file". What that is for a migration, this is for
// a call site — the fact is real, reachable, and invisible to every other kind of
// test available.
//
// WHAT THIS DOES NOT DO, stated so nobody mistakes it for more — and CORRECTED
// once already, because a limits statement that overclaims is worse than no
// limits statement at all. It does not check behaviour: a surface could call the
// right selector and still open the wrong conversation for a reason this file
// cannot see. And within its own terms it catches exactly this much:
//
//   * a REPLACED selector — the positive `toContain`, which every replacement
//     spelling fails, whatever it looks like;
//   * riding ALONGSIDE a correct selector, four named spellings: an `[0]` index
//     on the chat list, the `PROJECT_ROOM_TITLE` literal, a `.title ===`
//     comparison inside `.find(`, and a `.kind` comparison.
//
// Nothing else. A fallback spelled with a type annotation, a spaced index,
// `.at(0)`, destructuring, a block-bodied arrow, a dotted left-hand side or a
// `.includes` on a title all pass — measured, not feared: of sixteen spellings
// tried, four were caught. The `.kind` check was added because that measurement
// showed a kind-based fallback riding along with `findDesignRoomChat` passed
// every assertion in this file (8/8), which is the shape this whole change
// removed. Tightening further is a welcome follow-up; claiming it now would be
// the same defect again.

/// The file's CODE, with its comments removed.
///
/// Not a nicety: the comments in these files deliberately NAME the expressions
/// this test exists to keep out — "`channelChats[0]` was really alphabetically
/// first", "never by the title" — because a reader arriving at the fix needs to
/// know what it replaced. A naive grep matches the prose and fails on the
/// explanation instead of on the bug.
///
/// The `(^|\s)` before `//` is what stops a `https://` inside a string from
/// eating the rest of its line.
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "")
}

function sourceOf(relativePath: string): string {
  const sources: Record<string, string> = {
    "./DesignSurfacePage.tsx": designSurface,
    "../agents.tsx": agentsPage,
    "../../components/chat/chat-dock.tsx": dock,
  }
  const source = sources[relativePath]
  if (source == null) throw new Error(`no source imported for ${relativePath}`)
  return code(source)
}

/// Every place in the app that picks a ROOM for the user without being told which
/// one: the design rail's channel, the Agents page's auto-open, and the dock's
/// auto-open. All three must resolve through the marker selectors in
/// `live-mappers.ts`, which are themselves pinned by mutation in
/// `live-mappers.test.ts`.
const SURFACES = [
  {
    name: "the design rail",
    file: "./DesignSurfacePage.tsx",
    selector: "findDesignRoomChat(liveWorkspace, currentUser)",
  },
  {
    name: "the Agents page auto-open",
    file: "../agents.tsx",
    selector: "findPublicRoomChat(liveWorkspace, currentUser)",
  },
  {
    name: "the dock auto-open",
    file: "../../components/chat/chat-dock.tsx",
    selector: "findPublicRoomChat(liveWorkspace, currentUser)",
  },
]

describe("a room is selected by MARKER, never by title, kind or position", () => {
  for (const surface of SURFACES) {
    const selector = surface.selector.slice(0, surface.selector.indexOf("("))

    it(`${surface.name} selects through ${selector}`, () => {
      expect(sourceOf(surface.file)).toContain(surface.selector)
    })

    it(`${surface.name} selects by nothing else`, () => {
      const source = sourceOf(surface.file)
      // Four predicates, each of which resolves to a DIFFERENT room the moment a
      // project holds a second one — and a project may, because users create rooms
      // freely: the alphabetically first channel (`chats[0]`, which is really
      // "sorted by title", so "Design room" wins over "Project room"), the title a
      // human may reuse ("Project room", "Design room"), raw id order, and the
      // KIND — which says how a room is SCOPED, not which room it is: both project
      // rooms are `kind: "project"`, so a kind filter cannot separate them, and a
      // user's Group room satisfies whatever a project room satisfies.
      expect(source).not.toMatch(/\b(agentChannels|chats|channelChats)\[0\]/)
      expect(source).not.toContain("PROJECT_ROOM_TITLE")
      expect(source).not.toMatch(/\.find\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.title\s*===/)
      // None of the three surfaces has any legitimate `.kind` comparison — checked,
      // not assumed — so a comparison appearing here is the fallback this file
      // exists to keep out. If a surface ever has a real reason to compare a kind,
      // that is a decision to make deliberately and record here, not a test to
      // weaken quietly.
      expect(source).not.toMatch(/\.kind\s*[!=]==/)
    })
  }

  it("the design rail does not filter the room's messages by the message flag", () => {
    // The room IS the filter, which is why the fetch narrowing went too
    // (`fetchChannelMessages` no longer takes one — pinned in
    // `taskflow-api.test.ts`). Re-adding this in-memory filter would silently drop
    // rows that are in the design room while their own mirror flag disagrees, and
    // such rows exist: the flag is derived from the destination, so anything
    // written before that derivation can disagree with where it sits.
    expect(sourceOf("./DesignSurfacePage.tsx")).not.toMatch(/\.filter\(\(message\) => message\.isDesign\)/)
  })

  it("reads the code and not the prose", () => {
    // The helper above is load-bearing for every negative assertion in this file,
    // so it gets its own check: a stripper that quietly stopped working would turn
    // those assertions into ones that pass by matching nothing.
    const source = 'const a = 1 // chats[0]\n/* PROJECT_ROOM_TITLE */\nconst b = 2\nconst url = "https://example.test/x"\n'
    const stripped = code(source)
    expect(stripped).not.toContain("chats[0]")
    expect(stripped).not.toContain("PROJECT_ROOM_TITLE")
    expect(stripped).toContain("const a = 1")
    expect(stripped).toContain("const b = 2")
    expect(stripped).toContain('"https://example.test/x"')
  })
})
