/// The decision that persistence introduces: when a stored viewport exists, it
/// beats the manifest seed. Otherwise reopening the design page silently
/// re-opens every page the user closed.
///
/// A stored viewport with NO open routes is the exception — that reads as "the
/// record is empty", not as a deliberate choice, and seeding is the recoverable
/// behaviour (an empty canvas has no affordance to bring the pages back).

import type { DesignUIState } from "./design-ui-state"

export function shouldSeedRoutes(stored: DesignUIState | null, alreadySeeded: boolean): boolean {
  if (alreadySeeded) return false
  if (!stored) return true
  return stored.openRoutes.length === 0
}

/// #681: the open routes minus the ones the manifest no longer lists — a page
/// someone deleted (the trash does not keep it in the manifest; nobody deletes
/// a page and expects its board to stay open). Without this the board keeps an
/// iframe whose route is gone: a 404 rendered inside a device frame, which is
/// the "empty broken screen" the owner reported.
///
/// Returns the SAME array when nothing is missing: the caller is a `useState`
/// updater, and a fresh array on every manifest refetch would re-render the
/// canvas and re-persist the viewport for nothing.
export function dropMissingRoutes(
  openRoutes: string[],
  manifestRoutes: readonly string[],
): string[] {
  const known = new Set(manifestRoutes)
  const kept = openRoutes.filter((route) => known.has(route))
  return kept.length === openRoutes.length ? openRoutes : kept
}
