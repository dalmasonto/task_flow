/// The Pages tab, in three sections and in this order: the GROUPS — each with
/// its own pages as full rows — one bulk open/close control, then the UNGROUPED
/// pages as their own section, LAST. The user's own sketch, and each section
/// answers a different question:
///
/// * **Groups** — one block per group, in `layout.groups` order: a header
///   carrying the group's POSITION (`1. Auth`, the index in `layout.groups`,
///   which is what the user means by a group's position) and its move up/down
///   arrows, then the group's pages as ordinary rows beneath it. `+ Add group`
///   lives in this section's heading, because a group is what it makes. An
///   EMPTY group is drawn like any other — heading, arrows, no rows — which is
///   the state the user is in the moment they create one, and where the arrows
///   they need are.
/// * **Select all / Deselect** — the same `openRoutes` state every row's
///   checkbox writes, in bulk. A second ENTRY POINT, never a second state: the
///   box means "every page is on the canvas", which is what a row's box has
///   always meant. It stays between the two lists because it is a control
///   rather than a heading, and because that is where it reads as "every page"
///   — the groups above it, the rows below it.
/// * **Ungrouped** — every page no group claims, as its own list, last. It is
///   the state a project is in before anyone opens the group picker, so this is
///   the first-run listing, and it never disappears: a page has exactly one
///   place here or under a group (`groupedPages` partitions the manifest), and
///   a page drawn in both would be two rows writing one open state.
///
/// **Each row is numbered by its place in the section it is under** — a group
/// of two screens reads "1, 2", the next group starts at 1 again, and the
/// ungrouped section numbers itself. There is still ONE order in the project
/// and it is still global: `routeOrder`, the flow, which the canvas draws in
/// (`boardsForView`) and which decides the order of the pages WITHIN a group. So
/// the row's move arrows are a flow edit — `moveRouteInSection`, which ends in
/// `moveRoute` — and their ends are the flow's ends, not a section's.
///
/// What a click MEANS is the section: one place in the list the user is looking
/// at. A project's flow starts as the manifest's order and groups are subsets of
/// it, so two screens of one group are routinely several places apart in the
/// flow, and a plain ±1 move would charge one click per place between them —
/// with every click but the last changing nothing in this panel and nothing in
/// the `groups` canvas while reordering other groups' pages in `rows`/`bands`.
/// So the arrows move the page to just past the next page of its OWN section;
/// only where the section has nothing in that direction (its first page going
/// up, a single-page section either way) do they fall back to the flow's own one
/// place, and the arrow stays enabled there so nothing that worked before stops
/// working. That residue is bounded and it is the row about which "order the
/// screens in this group" has nothing to say: there is nothing above it in its
/// group. `moveRouteInSection` carries the full statement, including the reason
/// this shape was chosen over the two simpler ones and the one reason that had
/// to be retracted — that a section-local move "pushes other groups' pages along
/// the flow", which the plain flow move does as well, because any move crosses
/// what it passes.
///
/// There is deliberately NO per-group order stored anywhere, and adding one
/// would break the link between this list and the canvas: the two numberings
/// here are `groupedPages`' sections (drawn) and `numberedPages`' flow positions
/// (the arrows' bounds), both pure functions over the same document.
///
/// The canvas agrees with both: in the `groups` view its columns are
/// `layout.groups` in order — which is why the GROUP arrows, which move that
/// array and nothing else, move the columns — and its pages read down each
/// column in the flow, the same order this panel lists them in. What a row
/// still does NOT do is reorder the boards by grouping: assigning a page to a
/// group is a listing edit (`assignRoute` never touches `routeOrder`), so in
/// `rows` and `bands` it moves nothing at all.
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
  moveGroup,
  moveRouteInSection,
  pageLabel,
  setPageLabel,
  type LayoutDoc,
} from "@/lib/design-layout"

import {
  groupedPages,
  numberedPages,
  selectAllState,
  type GroupedPages,
  type NumberedPage,
} from "./pages-order"

/// The value the group picker carries for "no group". A page is in at most one
/// group, and none is a real state — `assignRoute` takes `null` for it — so the
/// picker needs a sentinel of its own: an empty string would be a value the
/// document cannot tell from a group id.
const UNGROUPED = "__ungrouped__"

/// The panel's section-heading style: `<h3>`, the level the rest of the app uses
/// for a section inside a page, so the panel's sections — `Groups` and
/// `Ungrouped` — are headings a screen reader can jump between rather than
/// merely styled text. A group inside the Groups section is an `<h4>` UNDER that
/// heading and wears its own, smaller style — it is an item of the section, not
/// another section.
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

  /// A group's move, through the same `updateLayout` path every other layout
  /// edit uses — and skipped entirely when `moveGroup` refused, which it signals
  /// by returning the document ITSELF.
  ///
  /// The refusal is unreachable through these two buttons: the ends are the only
  /// one an arrow can hit and they are disabled. It is kept for the reason
  /// `rename` below keeps its own: a refusal spent on the wire is a PUT of a
  /// document identical to the one the server already has, and a caller that
  /// hands a refusal on is one edit away from doing that on a path where it is
  /// reachable.
  const moveGroupBy = (id: string, delta: number) => {
    const next = moveGroup(layout, id, delta)
    if (next !== layout) onLayoutChange(next)
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
  // The sections are BOTH the groups and the ungrouped complement, and a page is
  // in exactly one of them: the panel replaces the flat list rather than drawing
  // one beside the groups, which is why "no page twice" is an invariant of
  // `groupedPages` and not a consequence of the markup.
  //
  // The order within a section is the FLOW, and the canvas reads down each of
  // its group columns in that same flow (`layoutGroups`), so the list and the
  // sequence on screen are one order rather than two. The edit that changes it
  // is a move — the arrows below — and that is the ONLY edit here that reaches
  // the canvas's arrangement.
  //
  // Grouping a page is a LISTING edit and stays one: `assignRoute` never touches
  // `routeOrder`, so picking a group for a page changes which section lists it
  // and nothing about the order the boards are drawn in (in `groups`, the view
  // that IS grouping, the page joins its column — the columns themselves keep
  // the document's order, which is what the group arrows move). The two edits
  // look alike from the outside, since a page's position on screen changes in
  // both, which is exactly why they are separated here rather than left to look
  // the same.
  const sections = groupedPages(layout, routes)
  /// The page's place in the FLOW, which the rows do not DRAW (their number is
  /// the section's) and which is the only thing bounding their move controls —
  /// see the row below and `numberedPages`.
  const flow = numberedPages(layout, routes)
  const flowPlace = new Map(flow.map((page) => [page.route, page.n]))
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
  /// controls, the name, the group picker. Drawn under the group the page
  /// belongs to — the same function for every section, so a group's rows and the
  /// ungrouped rows cannot drift apart. A plain function the lists map CALL, not
  /// a component they mount: a component defined in here would be a new type on
  /// every render of the panel, so React would remount every row —
  /// `PageName`'s editor and `LabelInput`'s draft included — each time anything
  /// above it changed. Called, a row is an ordinary keyed child of its list.
  ///
  /// `page.n` is the page's place in the section it is under, which is what the
  /// number prints. The move controls are bounded by the FLOW instead — see the
  /// block below — and they never use `page.n`.
  ///
  /// The rows of one section are in FLOW order and DO move when the user moves a
  /// page. That is a reorder of keyed children within one parent, so React moves
  /// the existing nodes rather than remounting them and an uncommitted label
  /// draft rides along with its row; what would remount a row is the manifest
  /// changing. Grouping, which never touches the flow, does not even move the
  /// row — it moves it to ANOTHER section's list, which is a different parent
  /// and therefore a fresh mount.
  const pageRow = (page: NumberedPage) => {
    const open = openRoutes.includes(page.route)
    const current = groupOf(layout, page.route)
    const label = layout.pageLabels[page.route] ?? ""
    const name = nameFor(page.route)
    /// Where the page sits in the flow — NOT the number printed beside it.
    /// `numberedPages` is a permutation of the manifest's pages, so its length
    /// is the flow's last place; the `?? 1` is for the type, since a row is only
    /// ever built out of the manifest's own routes.
    const place = flowPlace.get(page.route) ?? 1
    return (
      <li key={page.route} className="flex items-center gap-1.5 px-2 py-1">
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
        {/* The page's number: its place in the SECTION it is under, which is the
            group above it or the ungrouped heading. `pages-order.ts` decides
            it. */}
        <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
          {page.n}.
        </span>
        {/* The reorder control. `moveRouteInSection` is where one click means one
            place in the list this row is drawn in; it resolves the flow, moves
            the page past the next page of its own section — or one place along
            the flow where the section has nothing that way — and normalises what
            it stores through `moveRoute`, so every click writes an order the
            server accepts. The disabled ends are the FLOW's (`place`, not
            `page.n`): the first page of the flow has nothing above it in any
            section, and `moveRoute` refuses there. A disabled control is how that
            is shown; the refusal returns the document UNCHANGED, and handing that
            to `onLayoutChange` would PUT a document identical to the one the
            server already has. */}
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={`Move ${page.route} up`}
          disabled={place === 1}
          onClick={() => onLayoutChange(moveRouteInSection(layout, page.route, -1, paths))}
        >
          <ChevronUpIcon className="size-3" />
        </button>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          aria-label={`Move ${page.route} down`}
          disabled={place === flow.length}
          onClick={() => onLayoutChange(moveRouteInSection(layout, page.route, 1, paths))}
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
      </li>
    )
  }

  /// One group's block: its heading — the position number in `layout.groups`,
  /// then its name — its move controls, and its pages beneath it.
  ///
  /// The arrows move the group in `layout.groups` by one place, through
  /// `moveGroup`, which normalises nothing because there is nothing to normalise
  /// (a permutation of the groups is a document the server accepts) and refuses
  /// at the ends by returning the document itself — hence the disabled controls.
  /// They are the same family as the row's controls: `type="button"`, an
  /// `aria-label` naming what they move, and a position number in the heading
  /// that is what they change. That this also reorders the canvas's columns is
  /// `layoutGroups`' doing — it draws its columns in `doc.groups` order — so
  /// nothing here knows about the canvas at all.
  ///
  /// The section type is `GroupedPages`' own rather than a second spelling of
  /// it, so a section that grew a field could not be described correctly here
  /// and wrongly there.
  const groupBlock = (section: GroupedPages["groups"][number], index: number) => {
    const first = index === 0
    const last = index === sections.groups.length - 1
    return (
      <li key={section.id} className="flex flex-col pl-3">
        <div className="flex items-center gap-1 px-2 py-0.5">
          <h4 className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
            {index + 1}. {section.name}
          </h4>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            aria-label={`Move group ${section.name} up`}
            disabled={first}
            onClick={() => moveGroupBy(section.id, -1)}
          >
            <ChevronUpIcon className="size-3" />
          </button>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            aria-label={`Move group ${section.name} down`}
            disabled={last}
            onClick={() => moveGroupBy(section.id, 1)}
          >
            <ChevronDownIcon className="size-3" />
          </button>
        </div>
        {/* The group's pages, as a list of their own: the nesting the user asked
            for is a nesting here, not only a heading above a run of rows.
            `pl-3` is the visual half of it, and it is measured rather than
            guessed: without it a row's content starts 4px LEFT of its own
            group's heading (the heading row is `px-2` + the `<h4>`'s `px-1`,
            the row is `px-2`), which is nesting drawn backwards. The three
            insets are a ladder now — section heading 12px, group heading 24px,
            its rows 32px — and `pages-panel.test.ts` reads the ladder back out
            of these class lists, because there is no CSS engine in the test
            environment to measure it any other way. */}
        <ul className="flex flex-col pl-3">{section.pages.map(pageRow)}</ul>
      </li>
    )
  }

  return (
    <div className="flex flex-col py-1">
      {/* The Groups section: one block per group, each with its own rows. Its
          heading is drawn even with no groups at all, because `+ Add group` is
          in it: this button is the only caller of `createGroup`, so a heading
          that appeared only once something was grouped would take the first
          group out of reach. Gated on the CAP, not on emptiness — `createGroup`
          enforces the same cap itself, so this is display, and hiding the button
          at the cap is the whole of it. */}
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
        <ul className="flex flex-col">{sections.groups.map(groupBlock)}</ul>
      </div>
      {/* Bulk open/close, between the two lists. Nothing to select means no
          control: a checkbox over an empty project would do nothing, and a
          checked "Deselect" beside "No pages yet." is worse than nothing. */}
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
      {/* The ungrouped section, LAST — the order the user confirmed. It is drawn
          like a group is: always, with its rows beneath it however many there
          are. It is where a page with no group is listed, the list the bulk
          control above sits over, and — with no pages at all — where "No pages
          yet." goes, since it is the section that would have held them. */}
      <div className="flex flex-col">
        <h3 className={cn(SECTION_HEADING, "border-t")}>Ungrouped</h3>
        {/* `pl-1` is the 4px that puts these rows' content on the same x as
            their own heading's text (the heading is `px-3`; a row is `px-2`) —
            the same "a row must not start left of the heading it belongs to"
            rule the groups' rows are held to, applied to the section that has
            no group to be nested under. */}
        <ul className="flex flex-col pl-1">{sections.ungrouped.map(pageRow)}</ul>
        {routes.length ? null : (
          <p className="px-3 py-2 text-xs text-muted-foreground">No pages yet.</p>
        )}
      </div>
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
    // `title` is the route, and this button is the only sighted place IN THE
    // PANEL that can show one: the row draws four slots with no path among them,
    // and the picker beside it shows a group. It is not the only place on
    // screen, and saying so would be the same overstatement in the other
    // direction: the toolbar's `PagePicker` lists every manifest route with its
    // raw path, open or not, and the ⌘K palette's per-route hint shows one too.
    // The canvas's own surfaces — its row-header overlay in `rows` view, the
    // amber badge a strayed frame wears — exist only for boards that are open,
    // and the headers themselves resolve through `pageLabel`. What this adds is
    // the path BESIDE the name it belongs to, which is where the doubt is: a
    // label accepts anything up to `MAX_LABEL`, so a page renamed into ambiguity
    // has nothing next to its name to check against. The accessible name already
    // carries the route (`aria-label` below), so this closes the sighted gap
    // only.
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
