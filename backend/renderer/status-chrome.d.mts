// Types for status-chrome.mjs, so the v2_fe parity test type-checks.
export type StatusInk = "light" | "dark"
export type Appearance = "light" | "dark"
export type Report = { mode: StatusInk | null; background: string | null }
export type Chrome = {
  ink: StatusInk
  stripFill: string
  screenBackground: string
  colorScheme: "light" | "dark" | "normal"
}
export declare const LIGHT_INK: string
export declare const DARK_INK: string
export declare function relativeLuminance(colour: string): number | null
export declare function inkForBackground(colour: string | null | undefined): StatusInk | null
export declare function contrastRatio(a: number, b: number): number
export declare function inkColour(ink: StatusInk): string
export declare function resolveStatusInk(input: {
  mode: StatusInk | null
  appearance: Appearance | null
  background: string | null
  themeBackground: string | null
}): StatusInk
export declare const rgbOnly: (v: unknown) => string | undefined
export declare function frameChrome(
  input: { report: Report | null; appearance: Appearance | null; themeBackground: string | null },
  safeColour?: (v: string | null | undefined) => string | undefined,
): Chrome
export declare function statusFromPage(
  raw: unknown,
): { report: Report; appearance: Appearance | null; themeBackground: string | null } | null
