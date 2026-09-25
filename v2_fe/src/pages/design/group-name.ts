/// The rule a new group's name must satisfy, as a sentence the Pages panel can
/// show — `null` when the name is usable, otherwise the reason to refuse it.
///
/// # Why this exists at all
///
/// `createGroup` (`lib/design-layout.ts`) refuses a blank name, an over-long
/// one, a duplicate and a call at the cap — all four the same way: the document
/// back unchanged and an empty id. Behind `window.prompt` that was invisible
/// (the dialog closed, nothing appeared), and behind the new dialog it would
/// still be invisible without something to ASK. So the panel asks this before
/// it ever calls `createGroup`, disables Create on a reason, and prints the
/// sentence under the field.
///
/// The precedent is `setNameProblem` (`lib/resources.ts`), the resource
/// editor's live reason under its Add button: same shape, same purpose, same
/// wording style. Read them together — a user meeting both forms in one session
/// should not have to learn two vocabularies for "that name is taken".
///
/// # Two copies, and the test that holds them together
///
/// This is a SECOND copy of the rule `createGroup` enforces — deliberately. It
/// cannot delegate: `createGroup` is in `lib/`, and `lib/` importing this module
/// would be both a dependency inversion (`design-layout.ts`'s header states the
/// opposite direction: it is a leaf, kept free of anything that could depend on
/// it) and a real import cycle, since this module needs `MAX_GROUPS` and
/// `MAX_GROUP_NAME` from it. `setNameProblem` and `addSet` live in ONE file and
/// can share; these two cannot.
///
/// What keeps the copies honest is `group-name.test.ts`'s agreement table: every
/// refusal this file names is checked against `createGroup`'s own answer for the
/// same input, including both sides of every boundary. If the engine's rule
/// moves and this one does not, that table fails — which is the only
/// alternative to a Create button enabled over a name that does nothing, the
/// silent no-op this phase exists to remove.
///
/// Length is measured the way `createGroup` measures it — UTF-16 units, so a
/// 40-emoji name is refused here as it is there. That is NOT how the server
/// counts (`layout_doc.rs` uses `chars().count()`, code points, as
/// `setNameProblem` already does): the two disagree only for names carrying
/// astral characters, the frontend erring strict. Kept as-is because it is the
/// engine's rule being described here and this task does not change it; see the
/// task report for the one-line fix if the two should be levelled.

import { MAX_GROUPS, MAX_GROUP_NAME, type LayoutDoc } from "@/lib/design-layout"

/// null when `name` is usable for a new group, otherwise the reason to show.
///
/// The checks are in the order `createGroup` makes them, so the sentence is
/// about the rule the engine would have broken first — a name that is both
/// blank and at the cap reads as blank here, as it would there.
export function groupNameProblem(layout: LayoutDoc, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "A group needs a name."
  if (trimmed.length > MAX_GROUP_NAME) {
    return `A group name is limited to ${MAX_GROUP_NAME} characters.`
  }
  // Case-insensitive, like the engine's and the server's, and compared TRIMMED
  // on both sides: "  auth  " is as taken as "Auth" is.
  if (layout.groups.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" is already a group name.`
  }
  if (layout.groups.length >= MAX_GROUPS) return `At most ${MAX_GROUPS} groups.`
  return null
}
