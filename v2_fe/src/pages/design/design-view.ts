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
