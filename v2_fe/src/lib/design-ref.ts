/// The inspected-element reference that rides along with a design message. It is
/// encoded as a fenced ```design-ref``` block inside the message body (Phase 1
/// carries no new column), rendered as a chip and stripped from the displayed
/// prose. Parsing fails soft: a malformed block is treated as no ref.
export type DesignRef = {
  pagePath?: string
  componentName?: string
  elementPath?: string
  srcRef?: string
  viewport?: string
}

const FENCE = /```design-ref\s*\n([\s\S]*?)\n```/

export function encodeDesignRef(ref: DesignRef): string {
  return "```design-ref\n" + JSON.stringify(ref) + "\n```"
}

export function appendDesignRef(body: string, ref: DesignRef): string {
  const trimmed = body.trimEnd()
  return trimmed.length ? `${trimmed}\n\n${encodeDesignRef(ref)}` : encodeDesignRef(ref)
}

export function parseDesignRef(body: string): DesignRef | null {
  const match = body.match(FENCE)
  if (!match) return null
  try {
    const value = JSON.parse(match[1]) as unknown
    if (value && typeof value === "object") return value as DesignRef
    return null
  } catch {
    return null
  }
}

export function stripDesignRef(body: string): string {
  return body.replace(FENCE, "").trimEnd()
}
