/// #508: a link drawn between the FACING sides of two screens.
///
/// React Flow's stock edges start and end at fixed handles, so a link to a
/// screen that is not directly to the right leaves the source sideways and
/// detours round to the target — on a canvas where screens can sit anywhere,
/// most links looked tangled. A floating edge takes the line between the two
/// screens' centres, finds where it crosses each screen's border, and draws a
/// curve between those points: the arrow always leaves and arrives on the side
/// that faces the other screen. (React Flow's documented "floating edges"
/// pattern.)

import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type InternalNode,
} from "@xyflow/react"

/// Where the line from `node`'s centre toward `other`'s centre leaves `node`'s
/// rectangle.
function borderPoint(node: InternalNode, other: InternalNode): { x: number; y: number } {
  const w = (node.measured.width ?? 0) / 2
  const h = (node.measured.height ?? 0) / 2
  const cx = node.internals.positionAbsolute.x + w
  const cy = node.internals.positionAbsolute.y + h
  const ox = other.internals.positionAbsolute.x + (other.measured.width ?? 0) / 2
  const oy = other.internals.positionAbsolute.y + (other.measured.height ?? 0) / 2
  if (!w || !h) return { x: cx, y: cy }
  const xx1 = (ox - cx) / (2 * w) - (oy - cy) / (2 * h)
  const yy1 = (ox - cx) / (2 * w) + (oy - cy) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1
  return { x: w * (xx3 + yy3) + cx, y: h * (-xx3 + yy3) + cy }
}

/// Which side of `node` a border point is on — the direction the curve leaves.
function sideOf(node: InternalNode, p: { x: number; y: number }): Position {
  const x = Math.round(node.internals.positionAbsolute.x)
  const y = Math.round(node.internals.positionAbsolute.y)
  const w = node.measured.width ?? 0
  const h = node.measured.height ?? 0
  if (Math.round(p.x) <= x + 1) return Position.Left
  if (Math.round(p.x) >= x + w - 1) return Position.Right
  if (Math.round(p.y) <= y + 1) return Position.Top
  if (Math.round(p.y) >= y + h - 1) return Position.Bottom
  return Position.Top
}

export function FloatingEdge({ id, source, target, markerEnd, style, label, selected }: EdgeProps) {
  const from = useInternalNode(source)
  const to = useInternalNode(target)
  if (!from || !to) return null

  const start = borderPoint(from, to)
  const end = borderPoint(to, from)
  const [path, labelX, labelY] = getBezierPath({
    sourceX: start.x,
    sourceY: start.y,
    sourcePosition: sideOf(from, start),
    targetX: end.x,
    targetY: end.y,
    targetPosition: sideOf(to, end),
  })

  return (
    <>
      {/* A wide invisible hit area: a link is easy to click even at a
          zoomed-out scale where the line itself is a few pixels. */}
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={40} className="flow-edge-live" />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={`nodrag nopan pointer-events-none absolute rounded-full border px-4 py-1.5 text-[22px] font-semibold shadow-md ${
              selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground"
            }`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
