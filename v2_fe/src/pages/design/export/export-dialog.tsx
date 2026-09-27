/// #507: the design export dialog — what to export, for which device, dressed
/// how, as what — and a progress line while it runs.
///
/// The heavy half (`export-run.ts`: the rasteriser, jsPDF, JSZip, the frames'
/// CSS) is imported only when Export is pressed, so none of it ships with the
/// app.

import { useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { DesignManifest } from "@/lib/design-api"
import { DEVICE_GROUP_LABELS, DEVICE_PRESETS, deviceById } from "@/lib/design-devices"
import type { LayoutDoc } from "@/lib/design-layout"
import { cn } from "@/lib/utils"
import { exportFileName, exportItems, frameFor, screensPerPage, type ExportScope } from "./export-plan"

type ScopeKind = ExportScope["kind"]

const SCOPES: { kind: ScopeKind; label: string }[] = [
  { kind: "all", label: "All pages" },
  { kind: "groups", label: "Groups" },
  { kind: "open", label: "Open pages" },
  { kind: "pick", label: "Choose pages" },
]

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-muted-foreground"

/// The device list as Base UI's Select wants it: `items` maps each value to the
/// label its trigger shows (without it the trigger would print the raw id).
const DEVICE_ITEMS = DEVICE_PRESETS.map((d) => ({ value: d.id, label: `${d.label} · ${d.width}×${d.height}` }))

/// A row with a checkbox and its text, the whole row clickable.
function CheckRow({
  checked,
  onChange,
  disabled,
  children,
  aside,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-2.5 text-sm", disabled && "cursor-not-allowed opacity-50")}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </label>
  )
}

export function ExportDialog({
  open,
  onOpenChange,
  manifest,
  layout,
  openRoutes,
  labelFor,
  sandboxToken,
  projectName,
  theme,
  defaultDeviceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  manifest: DesignManifest | null
  layout: LayoutDoc
  openRoutes: string[]
  labelFor: (route: string) => string
  sandboxToken: string | null
  projectName: string
  theme: "light" | "dark"
  defaultDeviceId: string
}) {
  const routes = useMemo(() => manifest?.routes ?? [], [manifest])
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all")
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [deviceId, setDeviceId] = useState(defaultDeviceId)
  const [withFrame, setWithFrame] = useState(false)
  const [radius, setRadius] = useState(18)
  const [fullPage, setFullPage] = useState(false)
  const [format, setFormat] = useState<"pdf" | "png">("pdf")
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelled = useRef(false)

  const device = deviceById(deviceId)
  const frame = frameFor(deviceId)
  const scope: ExportScope =
    scopeKind === "groups"
      ? { kind: "groups", groupIds }
      : scopeKind === "pick"
        ? { kind: "pick", routes: picked }
        : { kind: scopeKind }
  const items = useMemo(
    () => exportItems(layout, routes, scope, openRoutes, labelFor),
    // `scope` is rebuilt every render; its parts are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, routes, scopeKind, groupIds, picked, openRoutes, labelFor],
  )
  const running = progress !== null
  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  const scopeLabel =
    scopeKind === "all"
      ? "All pages"
      : scopeKind === "open"
        ? "Open pages"
        : scopeKind === "groups"
          ? layout.groups.filter((g) => groupIds.includes(g.id)).map((g) => g.name).join(", ") || "Groups"
          : "Selected pages"

  const start = async () => {
    if (!sandboxToken || !items.length) return
    cancelled.current = false
    setError(null)
    setProgress({ done: 0, total: items.length, phase: "Starting" })
    try {
      const { runExport, saveBlob, ExportCancelled } = await import("./export-run")
      try {
        const blob = await runExport({
          items,
          device,
          sandboxToken,
          theme,
          frame: withFrame ? frame : null,
          radius,
          fullPage,
          format,
          projectName,
          scopeLabel,
          onProgress: (done, total, phase) => setProgress({ done, total, phase }),
          isCancelled: () => cancelled.current,
        })
        saveBlob(blob, exportFileName(projectName, deviceId, format === "pdf" ? "pdf" : "zip"))
        onOpenChange(false)
      } catch (err) {
        if (!(err instanceof ExportCancelled)) throw err
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The export failed.")
    } finally {
      setProgress(null)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-run cancels it at the next page boundary.
        if (!next) cancelled.current = true
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Export screens</DialogTitle>
          <DialogDescription>
            A PDF to share, or the screens as PNG images. Rendered here in your browser from the live pages.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <p className={fieldLabel}>Pages</p>
            <div className="flex flex-wrap gap-1.5">
              {SCOPES.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  disabled={running || (option.kind === "groups" && !layout.groups.length)}
                  onClick={() => setScopeKind(option.kind)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium ring-1 transition disabled:opacity-40",
                    scopeKind === option.kind
                      ? "bg-primary/10 text-primary ring-primary/30"
                      : "text-muted-foreground ring-border hover:bg-muted",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {scopeKind === "groups" ? (
              <div className="grid gap-1 rounded-lg border p-2">
                {layout.groups.map((group) => (
                  <CheckRow
                    key={group.id}
                    checked={groupIds.includes(group.id)}
                    onChange={() => setGroupIds((ids) => toggle(ids, group.id))}
                    aside={<span className="text-xs text-muted-foreground">{group.routes.length}</span>}
                  >
                    {group.name}
                  </CheckRow>
                ))}
              </div>
            ) : null}
            {scopeKind === "pick" ? (
              <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-2">
                {routes.map((route) => (
                  <CheckRow
                    key={route.path}
                    checked={picked.includes(route.path)}
                    onChange={() => setPicked((list) => toggle(list, route.path))}
                    aside={<span className="font-mono text-[11px] text-muted-foreground">{route.path}</span>}
                  >
                    {labelFor(route.path)}
                  </CheckRow>
                ))}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {items.length} screen{items.length === 1 ? "" : "s"} selected
            </p>
          </section>

          <section className="space-y-2">
            <p className={fieldLabel}>Export as</p>
            {/* Two formats, side by side — a choice this central is not hidden
                in a dropdown. */}
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Export format">
              {(
                [
                  { id: "pdf", title: "PDF document", hint: `${screensPerPage(device)} screens per page, with a cover` },
                  { id: "png", title: "Images", hint: "One PNG per screen, in a .zip" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={format === option.id}
                  disabled={running}
                  onClick={() => setFormat(option.id)}
                  className={cn(
                    "rounded-lg border p-3 text-left transition disabled:opacity-50",
                    format === option.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted",
                  )}
                >
                  <span className="block text-sm font-medium">{option.title}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-1.5">
            <p className={fieldLabel}>Device</p>
            <Select
              value={deviceId}
              items={DEVICE_ITEMS}
              disabled={running}
              onValueChange={(value) => typeof value === "string" && setDeviceId(value)}
            >
              <SelectTrigger aria-label="Device">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DEVICE_GROUP_LABELS) as (keyof typeof DEVICE_GROUP_LABELS)[]).map((group) => (
                  <SelectGroup key={group}>
                    <SelectGroupLabel>{DEVICE_GROUP_LABELS[group]}</SelectGroupLabel>
                    {DEVICE_PRESETS.filter((d) => d.group === group).map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label} · {d.width}×{d.height}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </section>

          <section className="space-y-2.5">
            <CheckRow
              checked={withFrame && !!frame}
              disabled={!frame || running}
              onChange={setWithFrame}
              aside={!frame ? <span className="text-xs text-muted-foreground">not for breakpoints</span> : null}
            >
              Show a device frame
            </CheckRow>
            {!(withFrame && frame) ? (
              <label className="flex items-center gap-3 text-sm">
                <span className="shrink-0">Corner radius</span>
                <input
                  type="range"
                  min={0}
                  max={48}
                  step={2}
                  value={radius}
                  disabled={running}
                  onChange={(event) => setRadius(Number(event.target.value))}
                  className="flex-1 accent-primary"
                  aria-label="Corner radius"
                />
                <span className="w-10 text-right font-mono text-xs text-muted-foreground">{radius}px</span>
              </label>
            ) : null}
            <CheckRow checked={fullPage} disabled={running} onChange={setFullPage}>
              Whole page length (not just the first screen)
            </CheckRow>
          </section>

          {running ? (
            <div className="space-y-1.5" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {progress.phase}… ({progress.done}/{progress.total})
              </p>
            </div>
          ) : null}
          {error ? <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p> : null}
          {!sandboxToken ? <p className="text-sm text-muted-foreground">Waiting for the design preview to load…</p> : null}
        </div>

        <DialogFooter>
          {running ? (
            <Button variant="ghost" onClick={() => (cancelled.current = true)}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
          <Button disabled={running || !items.length || !sandboxToken} onClick={() => void start()}>
            {running ? "Exporting…" : format === "pdf" ? "Export PDF" : "Export images"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
