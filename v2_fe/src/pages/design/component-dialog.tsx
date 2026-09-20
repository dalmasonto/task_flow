import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { MoonIcon, SunIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { sandboxUrl, type ComponentEntry } from "@/lib/design-api"

/// A small, dialog-scoped set of viewport widths — a quick sanity check, not
/// the full responsive-review device picker the toolbar has.
const VIEWPORT_PRESETS = [
  { id: "mobile", label: "Mobile", width: 375 },
  { id: "tablet", label: "Tablet", width: 744 },
  { id: "full", label: "Full", width: null },
] as const

type ViewportId = (typeof VIEWPORT_PRESETS)[number]["id"]

/// Task 9: clicking a component row in the Components tab opens this dialog,
/// rendering the SAME `/preview/:name` sandbox route the registry's small
/// thumbnail uses — just large — plus name/usage/attrs and a light/dark +
/// viewport-width control. Mirrors `AttachmentPreviewDialog`'s Base UI Dialog
/// portal/backdrop/popup/close idiom (components/message-attachments.tsx),
/// trimmed down: no zoom, no multi-item navigation, no chip-handoff layering —
/// this dialog is never opened underneath another surface.
export function ComponentDialog({
  component,
  sandboxToken,
  open,
  onClose,
}: {
  component: ComponentEntry | null
  sandboxToken: string | null
  open: boolean
  onClose: () => void
}) {
  const [theme, setTheme] = React.useState<"light" | "dark">("light")
  const [viewport, setViewport] = React.useState<ViewportId>("full")

  // Reset to a clean light/full view each time a (possibly different)
  // component is opened, rather than carrying over the last component's state.
  React.useEffect(() => {
    if (open) {
      setTheme("light")
      setViewport("full")
    }
  }, [open, component?.name])

  if (!component) return null

  const width = VIEWPORT_PRESETS.find((v) => v.id === viewport)?.width ?? null

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPrimitive.Portal>
        {/* z-75/76: above WorkspaceDialog's z-[60]/z-[70] backdrop+popup, below
            AttachmentPreviewDialog's foreground z-80/81 — this dialog is never
            opened underneath another surface, but must not collide with one
            still on screen behind it. */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-75 bg-[oklch(0.08_0.004_255_/_0.92)] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup className="fixed inset-3 z-76 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-background text-foreground shadow-2xl outline-none sm:inset-8">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-card/95 px-3 sm:px-4">
            <DialogPrimitive.Title className="min-w-0 flex-1">
              <span className="block truncate font-mono text-sm font-semibold">{component.name}</span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                Used on {component.usageCount} route{component.usageCount === 1 ? "" : "s"}
                {component.attrs.length
                  ? ` · ${component.attrs.length} attr${component.attrs.length === 1 ? "" : "s"}`
                  : ""}
              </span>
            </DialogPrimitive.Title>

            <div className="hidden items-center gap-1 sm:flex">
              {VIEWPORT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                    viewport === preset.id
                      ? "border-primary/35 bg-primary/10 text-primary"
                      : "border-border/70 bg-background/70 text-muted-foreground hover:bg-muted"
                  )}
                  onClick={() => setViewport(preset.id)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="rounded-lg"
              title="Toggle theme"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? <SunIcon /> : <MoonIcon />}
              <span className="sr-only">Toggle theme</span>
            </Button>

            <DialogPrimitive.Close
              render={<Button type="button" variant="outline" size="icon-sm" className="rounded-lg" />}
            >
              <XIcon />
              <span className="sr-only">Close preview</span>
            </DialogPrimitive.Close>
          </div>

          {component.attrs.length ? (
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-border/70 bg-card/60 px-3 py-2 sm:px-4">
              {component.attrs.map((a) => (
                <span
                  key={a}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {a}
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/35 p-4 sm:p-8">
            {sandboxToken ? (
              <ComponentSandboxFrame
                key={component.name}
                sandboxToken={sandboxToken}
                componentName={component.name}
                theme={theme}
                width={width}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Sandbox not ready.</p>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/// The same `/preview/:name` sandbox route the registry's small thumbnail
/// uses, rendered large. Theme is pushed via the `design:ready` / `design:theme`
/// postMessage handshake the canvas artboards already use (`design-canvas.tsx`'s
/// `LazyFrame`) — the composed document's injected picker runtime listens for
/// both on every sandbox route, this preview one included (composer.rs).
function ComponentSandboxFrame({
  sandboxToken,
  componentName,
  theme,
  width,
}: {
  sandboxToken: string
  componentName: string
  theme: "light" | "dark"
  width: number | null
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null)

  const pushTheme = React.useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "design:theme", theme }, "*")
  }, [theme])

  // Push whenever the toggle changes (frame already up) …
  React.useEffect(() => {
    pushTheme()
  }, [pushTheme])

  // … and once more when the frame announces it just finished loading, in case
  // the toggle-driven push above raced the frame's own bootstrap.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string } | undefined
      if (m?.type === "design:ready") pushTheme()
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [pushTheme])

  return (
    <div
      className="min-h-[240px] overflow-hidden rounded-xl border bg-white shadow-lg"
      style={{ width: width ?? "100%", maxWidth: width ?? 960 }}
    >
      <iframe
        ref={frameRef}
        src={`${sandboxUrl(sandboxToken, `/preview/${componentName}`)}?preview=1`}
        title={`Preview of ${componentName}`}
        sandbox="allow-scripts allow-same-origin"
        className="h-[70vh] w-full border-0"
        loading="eager"
      />
    </div>
  )
}
