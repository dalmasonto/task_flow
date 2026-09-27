/// #507: the design export dialog — what to export, for which device, dressed
/// how, as what — and a progress line while it runs.
///
/// The heavy half (`export-run.ts`: the rasteriser, jsPDF, JSZip, the frames'
/// CSS) is imported only when Export is pressed, so none of it ships with the
/// app.

import { useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
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
import { exportDress, exportFileName, exportItems, frameFor, screensPerPage, type DressStyle, type ExportScope } from "./export-plan"

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

const DRESS_OPTIONS: { id: DressStyle; title: string; hint: string }[] = [
  { id: "device", title: "Device", hint: "Realistic device frame" },
  { id: "classic", title: "Classic", hint: "Simple black bezel" },
  { id: "none", title: "None", hint: "Rounded screenshot" },
]

type ExportReport = {
  total: number
  missingImages: { item: { label: string; route: string }; urls: string[] }[]
}

/// The assets the export stood in for. Every screen is in the file; a screen
/// whose picture shows a placeholder card where an image could not be
/// fetched is named with the image urls, so the owner can see which host
/// would not serve it.
function ExportReportNote({ report }: { report: ExportReport }) {
  const { total, missingImages } = report
  const count = missingImages.reduce((n, m) => n + m.urls.length, 0)
  return (
    <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-950/30">
      <p className="font-medium text-amber-900 dark:text-amber-200">
        Saved all {total} screen{total === 1 ? "" : "s"}. {count === 1 ? "One image" : `${count} images`} could not be fetched and{" "}
        {count === 1 ? "shows" : "show"} as a placeholder:
      </p>
      <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-amber-900/80 dark:text-amber-200/80">
        {missingImages.map(({ item, urls }) => (
          <li key={item.route}>
            <span className="font-medium">{item.label}</span> ({item.route}):
            <ul className="list-none pl-0">
              {urls.map((u) => (
                <li key={u} className="truncate" title={u}>
                  {u}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ExportDialog({
  open,
  onOpenChange,
  manifest,
  layout,
  openRoutes,
  labelFor,
  projectId,
  sandboxToken,
  projectName,
  theme,
  defaultDeviceId,
  defaultDress,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  manifest: DesignManifest | null
  layout: LayoutDoc
  openRoutes: string[]
  labelFor: (route: string) => string
  projectId: number | null
  sandboxToken: string | null
  projectName: string
  theme: "light" | "dark"
  defaultDeviceId: string
  /// The frame style the canvas is showing — the export starts from it.
  defaultDress: DressStyle
}) {
  const routes = useMemo(() => manifest?.routes ?? [], [manifest])
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all")
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [deviceId, setDeviceId] = useState(defaultDeviceId)
  const [dressStyle, setDressStyle] = useState<DressStyle>(defaultDress)
  // The dialog stays mounted, so each OPENING starts again from what the
  // canvas shows now (its first device, its frame style).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setDressStyle(defaultDress)
      setDeviceId(defaultDeviceId)
    }
  }
  // Subtle by default: a screenshot's corners, not a device's.
  const [radius, setRadius] = useState(8)
  // The document's title: the project's name unless the operator says
  // otherwise for this export.
  const [title, setTitle] = useState(projectName)
  const [fullPage, setFullPage] = useState(false)
  const [format, setFormat] = useState<"pdf" | "png">("pdf")
  const [progress, setProgress] = useState<{ done: number; total: number; phase: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /// The assets the last export stood in for, shown once it has saved: the
  /// dialog stays open for it, because a closed dialog would say every
  /// picture was whole when some carry a placeholder.
  const [report, setReport] = useState<ExportReport | null>(null)
  const cancelled = useRef(false)

  const device = deviceById(deviceId)
  const isBreakpoint = !frameFor(deviceId)
  // What will actually be drawn: a breakpoint width wears no frame of either kind.
  const effectiveStyle = exportDress(deviceId, dressStyle).kind
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
    if (!sandboxToken || projectId === null || !items.length) return
    cancelled.current = false
    setError(null)
    setReport(null)
    setProgress({ done: 0, total: items.length, phase: "Starting" })
    try {
      const { runExport, saveBlob, ExportCancelled } = await import("./export-run")
      try {
        const { blob, missingImages } = await runExport({
          items,
          device,
          projectId,
          sandboxToken,
          theme,
          dress: exportDress(deviceId, dressStyle),
          radius,
          fullPage,
          format,
          projectName: title.trim() || projectName,
          scopeLabel,
          onProgress: (done, total, phase) => setProgress({ done, total, phase }),
          isCancelled: () => cancelled.current,
        })
        saveBlob(blob, exportFileName(title.trim() || projectName, deviceId, format === "pdf" ? "pdf" : "zip"))
        if (missingImages.length) {
          setReport({ total: items.length, missingImages })
        } else {
          onOpenChange(false)
        }
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

          <label className="block space-y-1.5">
            <span className={fieldLabel}>Document title</span>
            <Input
              value={title}
              maxLength={80}
              disabled={running}
              placeholder={projectName}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

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
            <div className="space-y-1.5">
              <p className={fieldLabel}>Frame</p>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Frame">
                {DRESS_OPTIONS.map((option) => {
                  const unavailable = option.id !== "none" && isBreakpoint
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={effectiveStyle === option.id}
                      disabled={running || unavailable}
                      title={unavailable ? "A breakpoint width is not a device, so it has no frame" : undefined}
                      onClick={() => setDressStyle(option.id)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition disabled:opacity-50",
                        effectiveStyle === option.id ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted",
                      )}
                    >
                      <span className="block text-sm font-medium">{option.title}</span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            {effectiveStyle === "none" ? (
              <label className="flex items-center gap-3 text-sm">
                <span className="shrink-0">Corner radius</span>
                <Slider
                  min={0}
                  max={32}
                  step={1}
                  value={radius}
                  disabled={running}
                  onValueChange={(value) => setRadius(Array.isArray(value) ? value[0] : value)}
                  className="flex-1"
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
          {report ? <ExportReportNote report={report} /> : null}
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
