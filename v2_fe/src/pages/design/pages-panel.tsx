/// The Pages tab, in three sections and in this order: the Groups as a
/// read-only overview, one bulk open/close control, then every page as a flat
/// numbered row. It is the user's own sketch, and each section answers a
/// different question:
///
/// * **Groups** — `1. Auth`, `2. Admin`, each with its pages as bullets
///   beneath it. NAMES ONLY: a page has exactly one number and it is the one
///   beside its row below, so the overview must not carry a numbering of its
///   own. `+ Add group` lives in this section's header, because a group is what
///   it makes.
/// * **Select all / Deselect** — the same `openRoutes` state every row's
///   checkbox writes, in bulk. A second ENTRY POINT, never a second state: the
///   box means "every page is on the canvas", which is what a row's box has
///   always meant.
/// * **The flat list** — every manifest route, one row each: the canvas
///   checkbox, the number, the move up/down controls, the name, the group
///   picker. It is listed in the FLOW (`routeOrder`) and numbered 1..N in it,
///   so "3" is the third screen of the sequence the user is presenting — see
///   `pages-order.ts`, which decides both.
///
/// The rows and the canvas agree about that sequence: the boards are drawn in
/// the same flow (`boardsForView`). What a row does NOT do is reorder the
/// boards: grouping is a listing edit, and the only edit here that reorders the
/// canvas is a move through the arrows below. (In the `groups` view a regrouped
/// page does move into its new column — that view IS the grouping — but the
/// columns keep their own order, and in `rows` and `bands` a grouping edit moves
/// nothing at all.)
///
/// Extracted from `DesignSurfacePage.tsx` (already ~1000 lines) when the group
/// picker landed; it is the one panel with per-row local interaction.
///
/// `+ Add group` opens the app's own `Dialog` (`components/ui/dialog.tsx`) —
/// this panel's `window.prompt` was the last native dialog in the app. The
/// dialog asks BEFORE it creates: `createGroup` refuses a blank, over-long or
/// duplicate name by returning the document unchanged and an empty id, which
/// behind a prompt or a closing dialog is a no-op nobody can see. So the rule is
/// asked first (`groupNameProblem`, beside `createGroup` in
/// `lib/design-layout.ts` — the same function `createGroup` refuses through, so
/// the sentence and the refusal cannot drift apart) and the answer is printed
/// under the field, Create disabled while it stands — the resource editor's live
/// reason, one panel over.
///
/// The group picker is the app's `Select` (`components/ui/select.tsx`), and the
/// reason this panel avoided it is worth keeping: that component is Base UI, not
/// Radix, and its `SelectValue` renders the raw VALUE unless the root is given
/// an `items` value→label map — so a row that loses the map reads `g1` where
/// `Auth` belongs. The row was a native `<select>` for exactly that reason.
/// That is now covered rather than avoided: `pages-panel.test.ts` renders this
/// panel and asserts the NAME in the markup. What that guard catches has no
/// native equivalent — a native `<select>` puts its option labels in the markup
/// too, so a render test could assert those — because this component's failure
/// is a SILENT value→label substitution: the raw id drawn where a name belongs,
/// with nothing on screen to contradict it. The map is `groupItems` below, built
/// once from `layout.groups`, and it is the only thing keeping the ids out of
/// the trigger.
///
/// The rename box stays a plain `<input>`: a field that edits its own text needs
/// no value→label map, and it commits on blur/Enter rather than on a change
/// event, which is not a Select's job. It is hidden behind the name until the
/// name is clicked (`PageName` below), which is what the sketch asks for.

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { DesignManifest } from "@/lib/design-api"
import { cn } from "@/lib/utils"
import {
  assignRoute,
  createGroup,
  groupNameProblem,
  groupOf,
  MAX_GROUPS,
  MAX_LABEL,
  moveRoute,
  pageLabel,
  setPageLabel,
  type LayoutDoc,
} from "@/lib/design-layout"

import { groupedPages, numberedPages, selectAllState, type NumberedPage } from "./pages-order"

/// The value the group picker carries for "no group". A page is in at most one
/// group, and none is a real state — `assignRoute` takes `null` for it — so the
/// picker needs a sentinel of its own: an empty string would be a value the
/// document cannot tell from a group id.
const UNGROUPED = "__ungrouped__"

/// The panel's section-heading style: `<h3>`, the level the rest of the app uses
/// for a section inside a page, so the panel's sections are headings a screen
/// reader can jump between rather than merely styled text. A group inside the
/// Groups section is an `<h4>` UNDER that heading and wears its own, smaller
/// style — it is an item of the section, not another section.
const SECTION_HEADING =
  "px-3 pt-2.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"

export function PagesPanel({
  manifest,
  openRoutes,
  onToggleRoute,
  onOpenRoutesChange,
  layout,
  onLayoutChange,
}: {
  manifest: DesignManifest | null
  openRoutes: string[]
  onToggleRoute: (route: string) => void
  /// Bulk open/close, for the Select all control: it REPLACES the open list
  /// rather than toggling one route, which is what `onToggleRoute` can express.
  /// Not optional — a panel that drew the control without a way to apply it
  /// would be offering a checkbox that does nothing, which is the defect class
  /// this phase exists to remove.
  ///
  /// The call site passes the raw setter, not the per-row toggle: opening a
  /// page from a row focuses its board (`toggleRouteFromPanel`), and a bulk open
  /// has no single board to focus. It is the same setter the toolbar's page
  /// picker already bulk-writes (`PagePicker`'s `onChange`).
  onOpenRoutesChange: (routes: string[]) => void
  layout: LayoutDoc
  onLayoutChange: (next: LayoutDoc) => void
}) {
  const routes = manifest?.routes ?? []

  /// The manifest's routes as plain paths, which is what the flow helpers take:
  /// the sequence is a list of routes, and every edit below builds a new
  /// document from it. Computed once here rather than at each call site.
  const paths = routes.map((entry) => entry.path)

  /// Whether the New group dialog is open. Held here, not inside it: the button
  /// that opens it is the panel's, and so is the `createGroup` call below.
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)

  /// Manifest entries by path, for the row's title fallback.
  const byPath = new Map(routes.map((entry) => [entry.path, entry]))

  /// The name a page is listed under, wherever this panel lists it: the row's
  /// name and the Groups section's bullets both come through here. The resolver
  /// is `pageLabel`, never `route.title` — the canvas headers resolve through
  /// the same call. A `NumberedPage` and a section's route are only ever built
  /// out of `routes`, so the lookup always hits; the raw path as the fallback
  /// (which `pageLabel` itself documents as the last resort) keeps a nameless
  /// line off the screen if it ever did not.
  const nameFor = (route: string) =>
    pageLabel(layout, route, byPath.get(route)?.title ?? route)

  const assign = (route: string, value: string) => {
    onLayoutChange(assignRoute(layout, route, value === UNGROUPED ? null : value))
  }

  /// Create the group the dialog named. `createGroup` stays the ONLY creation
  /// path — the dialog only decides whether to offer the button.
  ///
  /// An empty id here is unreachable: the dialog's Create button is enabled
  /// only while `groupNameProblem` returns null, and that is the same function
  /// `createGroup` refuses through. It is kept anyway — a refusal must leave the
  /// dialog open over the name rather than close on a group that was never made,
  /// which is the silent no-op this dialog exists to remove, and that stays true
  /// however the rule grows.
  const addGroup = (name: string) => {
    const { doc, id } = createGroup(layout, name)
    if (!id) return
    onLayoutChange(doc)
    setGroupDialogOpen(false)
  }

  // A rename is an edit to the SHARED arrangement document, so it goes through
  // the same `onLayoutChange`/`updateLayout` path every other layout edit uses
  // — there is deliberately no second save path for labels.
  //
  // Both "nothing happened" cases are caught here rather than spent on a PUT:
  // re-typing the label you already have still builds a new document object,
  // and an over-cap label is refused by `setPageLabel` returning the document
  // itself. Only a real change reaches the server.
  const rename = (route: string, value: string) => {
    if (value.trim() === (layout.pageLabels[route] ?? "")) return
    const next = setPageLabel(layout, route, value)
    if (next === layout) return
    onLayoutChange(next)
  }

  // Which group a page is listed under, in what order the pages are listed, and
  // which number each carries are `pages-order.ts`'s job rather than this
  // component's: pure functions, so there are tests on them (this repo's test
  // setup has no DOM, so JSX cannot have one), and one place that can be wrong
  // about the edge cases — a group the user deleted, a page two groups both
  // claim, a route the manifest does not have, a stored flow written against
  // different pages — instead of two.
  //
  // The order in both sections is the FLOW, and the canvas draws its boards in
  // that same flow (`boardsForView`), so the list and the sequence on screen are
  // one order rather than two. The edit that changes it is a move — the arrows
  // below — and that is the ONLY edit here that reaches the canvas's arrangement.
  //
  // Grouping a page is a LISTING edit and stays one: `assignRoute` never touches
  // `routeOrder`, so picking a group for a page changes which section lists it
  // and nothing about the order the boards are drawn in (in `groups`, the view
  // that IS grouping, the page joins its column — the columns themselves still
  // keep the document's order). The two edits look alike from the outside, since
  // a page's position on screen changes in both, which is exactly why they are
  // separated here rather than left to look the same.
  const sections = groupedPages(layout, routes)
  const flat = numberedPages(layout, routes)
  const bulk = selectAllState(routes, openRoutes)

  /// The group picker's items — and its value→label map, which is the same
  /// array: Base UI's `SelectValue` renders the raw value unless the root is
  /// given one, so this is what puts `Auth` in the row instead of `g1`. The
  /// ungrouped entry is spelled `—` because that is what the picker offered
  /// before it became a `Select`; the id stays in the document.
  const groupItems = [
    { value: UNGROUPED, label: "—" },
    ...layout.groups.map((group) => ({ value: group.id, label: group.name })),
  ]

  /// One page's row: the canvas checkbox, the number, the move up/down
  /// controls, the name, the group picker. A plain function the list maps CALL,
  /// not a component it mounts: a component defined in here would be a new type
  /// on every render of the panel, so React would remount every row —
  /// `PageName`'s editor and `LabelInput`'s draft included — each time anything
  /// above it changed. Called, a row is an ordinary keyed child of the list.
  ///
  /// The rows are in FLOW order and DO move when the user moves a page. That is
  /// a reorder of keyed children within one parent, so React moves the existing
  /// nodes rather than remounting them and an uncommitted label draft rides
  /// along with its row; what would remount a row is the manifest changing.
  /// Grouping, which never touches the flow, does not even move the row.
  ///
  /// The move controls are plain buttons at the ENDS of the flow: the first
  /// page's up and the last page's down are disabled, which is the same rule
  /// `moveRoute` refuses by one layer down. `page.n` is 1-based, so the ends are
  /// `1` and `flat.length`, and nothing needs the row's index.
  const pageRow = (page: NumberedPage) => {
    const open = openRoutes.includes(page.route)
    const current = groupOf(layout, page.route)
    const label = layout.pageLabels[page.route] ?? ""
    const name = nameFor(page.route)
    return (
      <div key={page.route} className="flex items-center gap-1.5 px-2 py-1">
        {/* The checkbox is the sketch's, and it is the panel's open/close
            control: it writes the same `openRoutes` the canvas draws from. It is
            also the ONLY thing in this row that toggles a page — the name beside
            it opens the label editor instead, and a click there must not reach
            this box. Nothing joins them: no wrapper handler, no `<label>` around
            the row. The move controls are buttons of their own for the same
            reason — a handler on the row would have made the checkbox and the
            arrows reach one another. */}
        <input
          type="checkbox"
          className="size-3.5 shrink-0 accent-foreground"
          aria-label={`Show ${page.route} on the canvas`}
          checked={open}
          onChange={() => onToggleRoute(page.route)}
        />
        {/* The page's place in the FLOW — the sequence the canvas draws its
            boards in, and what the arrows beside it change. `pages-order.ts`
            decides it. */}
        <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {page.n}.
        </span>
        {/* The reorder control. `moveRoute` resolves the flow, moves the page one
            place and normalises what it stores, so every click writes an order
            the server accepts. The ends are disabled because `moveRoute` refuses
            there — the first page cannot move up — and a disabled control is how
            that is shown: the refusal returns the document UNCHANGED, and handing
            that to `onLayoutChange` would PUT a document identical to the one the
            server already has. */}
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={`Move ${page.route} up`}
          disabled={page.n === 1}
          onClick={() => onLayoutChange(moveRoute(layout, page.route, -1, paths))}
        >
          <ChevronUpIcon className="size-3" />
        </button>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={`Move ${page.route} down`}
          disabled={page.n === flat.length}
          onClick={() => onLayoutChange(moveRoute(layout, page.route, 1, paths))}
        >
          <ChevronDownIcon className="size-3" />
        </button>
        <PageName
          route={page.route}
          label={label}
          name={name}
          onCommit={(value) => rename(page.route, value)}
        />
        {/* The row's group picker. `items` is load-bearing — see the header. */}
        <Select
          value={current?.id ?? UNGROUPED}
          items={groupItems}
          onValueChange={(value) => assign(page.route, typeof value === "string" ? value : UNGROUPED)}
        >
          <SelectTrigger
            className="h-auto w-24 shrink-0 gap-1 rounded border bg-transparent px-1 py-0.5 text-[11px]"
            aria-label={`Group for ${page.route}`}
          >
            <SelectValue className="min-w-0 truncate" />
          </SelectTrigger>
          <SelectContent>
            {groupItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  return (
    <div className="flex flex-col py-1">
      {/* The Groups overview. Its header is drawn even with no groups at all,
          because `+ Add group` is in it: this button is the only caller of
          `createGroup`, so a header that appeared only once something was
          grouped would take the first group out of reach. Gated on the CAP, not
          on emptiness — `createGroup` enforces the same cap itself, so this is
          display, and hiding the button at the cap is the whole of it. */}
      <div className="flex flex-col">
        <div className="flex items-center gap-1 pr-2">
          <h3 className={cn(SECTION_HEADING, "flex-1")}>Groups</h3>
          {layout.groups.length < MAX_GROUPS ? (
            <button
              className="shrink-0 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setGroupDialogOpen(true)}
            >
              + Add group
            </button>
          ) : null}
        </div>
        {/* Read-only, and numbered by the GROUP's own position. The pages under
            each group are names and nothing else: the numbers belong to the flat
            list below, where a page has exactly one. */}
        <ul className="flex flex-col gap-0.5 px-3 py-1">
          {sections.groups.map((section, index) => (
            <li key={section.id} className="flex flex-col">
              <h4 className="truncate text-xs font-medium">
                {index + 1}. {section.name}
              </h4>
              {section.pages.length ? (
                <ul className="flex flex-col pl-3 text-xs text-muted-foreground">
                  {section.pages.map((route) => (
                    <li key={route} className="truncate">
                      {nameFor(route)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {/* Bulk open/close, between the overview and the list. Nothing to select
          means no control: a checkbox over an empty project would do nothing,
          and a checked "Deselect" beside "No pages yet." is worse than nothing. */}
      {routes.length ? (
        <label className="mt-1 flex items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 shrink-0 accent-foreground"
            checked={bulk.allOpen}
            onChange={() => onOpenRoutesChange(bulk.next)}
          />
          {bulk.label}
        </label>
      ) : null}
      {/* The flat list: every page, in the flow, numbered 1..N in it. */}
      {routes.length ? (
        <div className="flex flex-col">{flat.map(pageRow)}</div>
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>
      )}
      {/* Mounted, not mounted-and-open: the dialog renders nothing until it is
          open, and holding its `open` here is what lets `addGroup` close it. */}
      <NewGroupDialog
        open={groupDialogOpen}
        layout={layout}
        onOpenChange={setGroupDialogOpen}
        onCreate={addGroup}
      />
    </div>
  )
}

/// The New group dialog: a labelled field, the reason a name is refused, and
/// Create/Cancel. Escape, the focus trap and focus restore are Base UI's
/// (`components/ui/dialog.tsx`); Enter submits through the field.
///
/// The reason is the point of the whole thing. `createGroup` refuses a blank,
/// over-long or duplicate name by returning the document unchanged and an empty
/// id, so a dialog that simply closed would be a no-op the user reads as
/// success. Create is therefore disabled while `groupNameProblem` returns a
/// reason, and the reason is printed under the field — the resource editor's
/// rule, and this phase's whole subject.
///
/// The draft is cleared when the dialog OPENS (adjusting state during render —
/// the pattern `LabelInput` below uses for a prop that changes), so a name typed
/// and then cancelled is not waiting behind the next open. There is no error
/// state to keep: the reason is derived from the live `layout` on every
/// keystroke, so it also follows a group someone else deletes while it is open.
///
/// The field is the app's `Input` (a styled `<input>`) and the actions are the
/// app's `Button`, which is the convention for a modal's own form
/// (`WorkspaceDialog`, `TaskRefNotice`). The panel's rows are the exception, not
/// the rule: they are dense, per-row controls wearing the row's own sizing.
function NewGroupDialog({
  open,
  layout,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  layout: LayoutDoc
  onOpenChange: (open: boolean) => void
  /** The typed name, when it is usable. The caller creates the group. */
  onCreate: (name: string) => void
}) {
  const [name, setName] = useState("")
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setName("")
  }

  const problem = groupNameProblem(layout, name)
  /// The field is not marked invalid until something has been typed: an empty
  /// box beside a disabled Create already says "type a name", and a red border
  /// on open reads as a mistake the user has not made yet. A box holding only
  /// spaces DOES show it — that is the case where the sentence is the only way
  /// to find out why Create will not light up.
  const showProblem = problem !== null && name !== ""
  /// The reason's own id, so the field can point at it: a screen reader reads
  /// "invalid" and the sentence together, rather than announcing the field and
  /// leaving the why somewhere after it.
  const problemId = `${useId()}-problem`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>
            A group is a listing in this panel, not a layout: pages you put in it
            keep their place on the canvas.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            // Create is disabled under a reason, and a disabled submit button
            // means Enter in the field submits nothing — this guard is the
            // second half of that, so no keystroke can reach `createGroup` with
            // a name the engine will refuse.
            if (problem !== null) return
            onCreate(name)
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            <span>Group name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Auth"
              autoComplete="off"
              aria-invalid={showProblem ? true : undefined}
              aria-describedby={showProblem ? problemId : undefined}
            />
          </label>
          {showProblem ? (
            <p id={problemId} className="text-xs text-amber-600">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            {/* `render`, the same composition `ComponentDialog` uses: the
                dialog's own Close, wearing this app's Button. */}
            <DialogClose
              render={<Button type="button" variant="outline" size="sm" />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={problem !== null}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/// The row's name, and the label editor behind it: `[Click to edit label]`, as
/// the sketch draws it. The name is TEXT until it is clicked — an always-live
/// input in a row of controls reads as a field to fill in, and the panel's rows
/// are a listing first — and a click swaps it for `LabelInput`, whose
/// commit-on-blur/Enter semantics and refusal rules are unchanged.
///
/// The click reaches nothing else. There is no row-level handler and no
/// `<label>` around the row, so the canvas checkbox beside the name cannot be
/// toggled by opening the editor, and the button is `type="button"` besides.
///
/// Escape is the one key that does NOT leave the editor: `LabelInput` reverts
/// the draft in place, and the box stays where it is with the old name in it —
/// exactly what it did before the name became clickable. Leaving the row then
/// commits the reverted text, which is the label it already had, so nothing is
/// written.
function PageName({
  route,
  label,
  name,
  onCommit,
}: {
  route: string
  /** The stored label, `""` when the page has none. */
  label: string
  /** The name in use while there is no label: the page's own title. */
  name: string
  onCommit: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)

  if (!editing) {
    // `title` is the route, and this button is the only sighted place in the
    // PANEL that can show one: the row draws four slots with no path among them,
    // and the picker beside it shows a group. For a page that is NOT open on the
    // canvas the only other sighted path is the ⌘K palette's per-route hint —
    // the canvas's own surfaces (its row-header overlay in `rows` view, the
    // amber badge a strayed frame wears) exist only for boards that are open,
    // and the headers themselves resolve through `pageLabel`. A label accepts
    // anything up to `MAX_LABEL`, so a page renamed into ambiguity has nothing
    // beside its name to check against. The accessible name already carries the
    // route (`aria-label` below), so this closes the sighted gap only.
    return (
      <button
        type="button"
        className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        aria-label={`Label for ${route}`}
        title={route}
        onClick={() => setEditing(true)}
      >
        {name}
      </button>
    )
  }
  return (
    <LabelInput
      route={route}
      label={label}
      name={name}
      onCommit={onCommit}
      onCommitted={() => setEditing(false)}
    />
  )
}

/// The rename box: a plain `<input>`, never a Base UI field. Commits on Enter or
/// blur, reverts on Escape.
///
/// It holds the LABEL only, never the resolved name: an empty box means "no
/// label", so clearing it is how a label is removed — the page's own title
/// shows through again, and `name` is the placeholder saying which that is.
/// The committed value therefore goes straight to `setPageLabel` with no "is
/// this the title after all?" special case: re-typing the title just pins it as
/// a label, which renders identically.
///
/// It mounts into the name's own slot (`PageName`), so it is focused on mount
/// and sized like the name it replaces: clicking a name and having to click
/// again to type is the affordance the sketch is trying to remove.
function LabelInput({
  route,
  label,
  name,
  onCommit,
  onCommitted,
}: {
  route: string
  /** The stored label, `""` when the page has none. */
  label: string
  /** The name in use while the box is empty: the page's own title. */
  name: string
  onCommit: (value: string) => void
  /** Called after a commit, whatever committed it. The name swaps itself back
   *  for the text on it — the box would otherwise sit open over a value the
   *  user has already saved. Escape does NOT call it: it reverts in place. */
  onCommitted: () => void
}) {
  const [draft, setDraft] = useState(label)
  // The label this box last synced with. Adjusting state during render —
  // React's documented pattern for "state that changes when a prop changes" —
  // is what stops a stale draft being committed over someone else's rename:
  // focus the box, another viewer renames the page, click away, and a blur
  // would otherwise write back the name the box was still showing.
  const [syncedLabel, setSyncedLabel] = useState(label)
  if (syncedLabel !== label) {
    setSyncedLabel(label)
    setDraft(label)
  }

  return (
    <input
      className="min-w-0 flex-1 rounded border bg-transparent px-1 py-0.5 text-sm"
      aria-label={`Label for ${route}`}
      placeholder={name}
      value={draft}
      // The cap is the server's (`MAX_LABEL`, i.e. the layout document's own
      // rule); holding it on the box means an over-cap label is never typed,
      // and the refusal in `setPageLabel` stays the contract for other callers.
      maxLength={MAX_LABEL}
      // The box IS the click: it mounts in place of the name the user just
      // clicked, so focus comes with it. Leaving focus on the body would make
      // "click to edit" a two-click gesture.
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onCommit(draft)
        onCommitted()
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onCommit(draft)
          onCommitted()
        }
        // Revert in place WITHOUT blurring: a blur here would commit the very
        // draft this branch is discarding.
        else if (e.key === "Escape") setDraft(label)
      }}
    />
  )
}
