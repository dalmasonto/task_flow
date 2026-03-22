# Design System Specification: The Kinetic Terminal

## 1. Overview & Creative North Star
The Creative North Star for this design system is **"The Kinetic Terminal."** 

This system rejects the soft, rounded "friendly" web of the last decade in favor of high-velocity precision, editorial brutalism, and data-driven energy. We are creating a digital environment that feels like a high-end command center—where deep charcoal voids are punctuated by razor-sharp "light leaks" and vibrant neon data states. 

To move beyond a generic "cyberpunk" trope, we utilize intentional asymmetry, extreme typographic scales, and a "No-Line" philosophy. The layout shouldn't feel like a series of containers; it should feel like a single, cohesive dark-mode canvas where information is etched in light.

---

## 2. Colors & The Glow Architecture
The palette is built on a foundation of absolute darkness (`#0e0e0e`), allowing our three neon pillars to function as semantic beacons.

### The Semantic Neon Logic
*   **Primary (Electric Purple - `#de8eff`):** The brand's pulse. Used for high-level navigation, primary actions, and "active" processing states.
*   **Secondary (Cyan - `#00fbfb`):** The "Information" state. Used for data visualization, secondary filtering, and completed task states.
*   **Tertiary (Lime - `#69fd5d`):** The "Success" or "System Go" state. Used for validation, final confirmations, and positive growth metrics.

### The "No-Line" Rule & Glowing Traces
Standard 1px solid borders are strictly prohibited for sectioning. They create visual "noise" that slows down the user's eye. Instead:
1.  **Tonal Transitions:** Define sections by shifting from `surface` (`#0e0e0e`) to `surface-container-low` (`#131313`) or `surface-container-high` (`#20201f`).
2.  **The Glow Trace:** Where a boundary is required for "cyberpunk-lite" aesthetics, use a "Ghost Border." This is a 1px top or left border only, using the accent color (e.g., `primary`) at 20% opacity. This mimics a light-leak on a glass edge.
3.  **Signature Textures:** For hero elements, use a subtle linear gradient transitioning from `primary_dim` (`#b90afc`) to `primary` (`#de8eff`) at a 45-degree angle to provide a sense of "moving light."

---

## 3. Typography: The Space Grotesk Engine
We use **Space Grotesk** across the entire system. Its geometric construction and wide apertures provide the "modern/sharp" feel of a code editor while maintaining editorial legibility.

*   **Display Scale:** Use `display-lg` (3.5rem) with `-0.04em` letter spacing for hero headlines. This creates a dense, authoritative block of text.
*   **The Mono-Aesthetic:** For labels and data points, use `label-md` (0.75rem) in all-caps with `+0.1em` letter spacing. This evokes the "terminal" feel.
*   **Hierarchy through Contrast:** Pair a `headline-lg` (2rem) in `on_surface` (White) with a `body-sm` (0.75rem) in `on_surface_variant` (Grey) to create a dramatic, high-end editorial tension.

---

## 4. Elevation & Depth: Tonal Layering
In this design system, "up" does not mean "closer to a light source." It means "more energetic." We ignore traditional drop shadows in favor of **Tonal Layering** and **Glassmorphism.**

*   **The Layering Principle:** 
    *   **Base:** `surface` (`#0e0e0e`)
    *   **Level 1 (Cards/Sidebar):** `surface-container` (`#1a1a1a`)
    *   **Level 2 (Popovers/Modals):** `surface-container-highest` (`#262626`)
*   **Ambient Glows:** Instead of black shadows, floating elements (like a Primary Action Button) should have a soft, diffused `primary` tinted shadow at 8% opacity. Use a large blur (24px-32px) to simulate a neon light glowing against a dark wall.
*   **Glassmorphism:** For overlays, use `surface_bright` at 60% opacity with a `20px` backdrop blur. This ensures the neon "energy" of the background is never fully lost, maintaining the system's depth.

---

## 5. Components

### Buttons
*   **Primary:** Sharp 0px corners. Background is `primary`. Text is `on_primary`. On hover, add a `0 0 15px primary` box-shadow to "power up" the button.
*   **Secondary:** Sharp 0px corners. 1px "Ghost Border" using `secondary` at 40%. Text is `secondary`.
*   **Tertiary:** No background or border. Text is `on_surface_variant`. Underline on hover using a 2px `tertiary` stroke.

### Input Fields
*   **Base State:** `surface-container-low` background, 0px radius, 1px bottom border only using `outline_variant`.
*   **Focus State:** The bottom border transforms into a 2px `secondary` (Cyan) glow. Helper text appears in `label-sm`.
*   **Error State:** The bottom border and label shift to `error` (`#ff6e84`).

### Cards & Lists
*   **The Grid:** Use the spacing scale `8` (1.75rem) for internal padding.
*   **Separation:** Forbid the use of divider lines. Separate list items using a background shift to `surface-container-lowest` on hover, or a simple vertical 0.4rem (`2`) gap.
*   **Data Chips:** Small, 0px radius containers using `surface-variant`. Use a 2px left-border of `primary`, `secondary`, or `tertiary` to denote status.

### The "Pulse" Indicator (Custom Component)
A small 4x4px square of neon color that breathes (opacity 40% to 100%) next to active tasks or live data streams to emphasize the "Kinetic" nature of the system.

---

## 6. Do's and Don'ts

### Do:
*   **Use Intentional Asymmetry:** Align a display-sm title to the far left and a body-sm paragraph to the right of a 12-column grid.
*   **Embrace the Void:** Use the `24` (5.5rem) spacing token to allow headers to breathe against the deep charcoal background.
*   **Stick to 0px:** Every element—from buttons to modals—must have a `0px` border radius. Sharpness is our signature.

### Don't:
*   **Don't use Rounded Corners:** Any radius above 0px breaks the "Kinetic Terminal" aesthetic.
*   **Don't use Grey Shadows:** Shadows must be tinted with the accent color or avoided entirely in favor of tonal shifts.
*   **Don't Over-Glow:** If everything glows, nothing is important. Reserve the neon "light-leak" borders for active or high-priority elements only.
*   **Don't use Standard Dividers:** Never use a full-width grey line to separate content. Use whitespace or subtle background-color steps.