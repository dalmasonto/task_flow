/// Rules for the new-project page (tested in project-new-logic.test.ts).

const PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

/// `owner/repo` from what people paste: the short form, or a github.com URL
/// (with or without `.git`, a trailing slash, or a deeper path). Null when it
/// can't be a GitHub repo, so the form can say so before anything is created.
export function parseRepo(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "").replace(/^git@github\.com:/i, "")
  const [owner, rawRepo] = s.split("/")
  const repo = (rawRepo ?? "").replace(/\.git$/i, "")
  if (!owner || !repo || !PART.test(owner) || !PART.test(repo) || repo === "." || repo === "..") return null
  return `${owner}/${repo}`
}
