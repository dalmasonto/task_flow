import { describe, expect, it } from "vitest"

import { encodeMentions, mentionToken, parseMentionHref, plainExcerpt, plainMentions } from "./mention-tokens"

const builder = { kind: "agent" as const, id: "12", label: "Builder agent" }
const short = { kind: "agent" as const, id: "7", label: "Builder" }
const page = { kind: "page" as const, id: "/settings", label: "Settings" }

describe("mention tokens (#318 / #506)", () => {
  it("encodes a picked name with spaces as one token", () => {
    expect(encodeMentions("@Builder agent please look", [builder])).toBe("[@Builder agent](agent:12) please look")
  })

  it("prefers the longest picked label, so a shorter name inside it is not split out", () => {
    expect(encodeMentions("@Builder agent and @Builder", [short, builder])).toBe(
      "[@Builder agent](agent:12) and [@Builder](agent:7)",
    )
  })

  it("encodes a page mention by its route", () => {
    expect(encodeMentions("see @Settings.", [page])).toBe("see [@Settings](page:/settings).")
  })

  it("leaves text the picker did not insert alone", () => {
    expect(encodeMentions("mail a@Builder or @Someone", [short])).toBe("mail a@Builder or @Someone")
  })

  it("does not re-encode a token", () => {
    const once = encodeMentions("@Builder", [short])
    expect(encodeMentions(once, [short])).toBe(once)
  })

  it("parses a mention href and ignores ordinary links", () => {
    expect(parseMentionHref("agent:12")).toEqual({ kind: "agent", id: "12" })
    expect(parseMentionHref("page:/settings")).toEqual({ kind: "page", id: "/settings" })
    expect(parseMentionHref("https://example.com")).toBeNull()
  })

  it("strips brackets from a label so the link cannot end early", () => {
    expect(mentionToken({ kind: "user", id: "3", label: "Ann [ops]" })).toBe("[@Ann ops](user:3)")
  })
})

describe("plainMentions", () => {
  it("turns tokens back into @Name and leaves ordinary links", () => {
    expect(plainMentions("hi [@Builder agent](agent:12), see [@Settings](page:/settings) and [docs](https://x.y)")).toBe(
      "hi @Builder agent, see @Settings and [docs](https://x.y)",
    )
  })
})

describe("plainExcerpt", () => {
  it("drops markdown marks and keeps mentions readable", () => {
    expect(plainExcerpt("**Done:** ping [@Ann](user:3)\n\n`code` # x")).toBe("Done: ping @Ann code x")
  })
})
