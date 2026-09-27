/// A profile names one identity inside `.taskflow.json` (`main`, `reviewer`) and
/// is what `TASKFLOW_PROFILE` selects: an identifier, not prose.
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

/// An agent's profile is the last segment of its identifier
/// (`agent:<project>:<name>:<profile>`), which is where the link flow put it.
/// Empty when the identifier does not end in one.
export function profileOf(identifier: string): string {
  const last = identifier.split(":").pop() ?? ""
  return PROFILE_PATTERN.test(last) ? last : ""
}
