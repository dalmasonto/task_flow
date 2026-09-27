/// #318 / #506: mentions stored by IDENTITY, not by name.
///
/// A display name has spaces and can collide, so "@Builder agent please" cannot
/// be read back reliably — where does the name end? A mention is therefore
/// stored in the body as a markdown link whose URL names the entity:
///
///     [@Builder agent](agent:12)   [@Dalmas](user:3)   [@Settings](page:/settings)
///
/// It renders as a chip (`markdown-renderer.tsx`), and anything that shows the
/// raw body — an agent's terminal, a notification — still reads it as plain
/// "@Builder agent" followed by who that is.
///
/// The composer keeps showing plain `@Name` while you type: the picker records
/// exactly which entity each inserted name stands for, and `encodeMentions`
/// swaps those names for tokens at send time. Nothing is inferred from text the
/// picker did not insert.

export type MentionKind = "agent" | "user" | "page"

/// One entity the picker inserted. `id` is a string so a page's route fits.
export type PickedMention = { kind: MentionKind; id: string; label: string }

/// A mention link's URL, e.g. `agent:12` or `page:/settings`.
export const MENTION_URL = /^(agent|user|page):(\S+)$/

export function parseMentionHref(href: string | null | undefined): { kind: MentionKind; id: string } | null {
  const match = MENTION_URL.exec(href ?? "")
  if (!match) return null
  return { kind: match[1] as MentionKind, id: match[2] }
}

/// The stored form of one mention. Brackets are dropped from the label since
/// they would end the link text early; the id is what identifies it anyway.
export function mentionToken(mention: PickedMention): string {
  const label = mention.label.replace(/[[\]]/g, "").trim()
  return `[@${label}](${mention.kind}:${mention.id})`
}

/// A body as plain text: every mention token back to its `@Name`. For places
/// that show a message as one line of text (a reply quote), not as markdown.
export function plainMentions(text: string): string {
  return text.replace(/\[@([^\]]*)\]\((?:agent|user|page):\S+?\)/g, "@$1")
}

/// A body as ONE line of plain text, for a quote: mentions as `@Name`, the
/// markdown emphasis/code/heading marks dropped, whitespace collapsed.
export function plainExcerpt(text: string): string {
  return plainMentions(text).replace(/[*_`~#>]+/g, "").replace(/\s+/g, " ").trim()
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/// Replace every `@Label` the picker inserted with its token. Longest label
/// first, so "@Builder agent" is not claimed by a picked "@Builder". A name
/// already inside a token (preceded by `[`) or glued to a word is left alone,
/// and a picked name the user has since deleted simply matches nothing.
export function encodeMentions(body: string, picked: PickedMention[]): string {
  const unique = new Map<string, PickedMention>()
  for (const mention of picked) unique.set(`${mention.kind}:${mention.id}:${mention.label}`, mention)
  const ordered = [...unique.values()].sort((a, b) => b.label.length - a.label.length)
  let out = body
  for (const mention of ordered) {
    const pattern = new RegExp(`(^|[^\\[\\w])@${escapeRegExp(mention.label)}(?=$|[\\s.,!?;:)\\]])`, "g")
    out = out.replace(pattern, (_match, lead: string) => `${lead}${mentionToken(mention)}`)
  }
  return out
}
