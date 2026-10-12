/// A line diff for the Toolbox's version history: enough to re-read what
/// changed between two versions of a script without pulling in a diff library.
///
/// A plain longest-common-subsequence over lines — the same algorithm the MCP
/// uses for `toolbox_diff`, so the page and the agent's view of "what changed"
/// agree.

export type DiffLine = { kind: "same" | "add" | "remove"; text: string; left?: number; right?: number }

export function diffText(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i]
      const next = lcs[i + 1]
      if (!row || !next) continue
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i] ?? ""
    const right = b[j] ?? ""
    if (left === right) {
      lines.push({ kind: "same", text: left, left: i + 1, right: j + 1 })
      i += 1
      j += 1
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "remove", text: left, left: i + 1 })
      i += 1
    } else {
      lines.push({ kind: "add", text: right, right: j + 1 })
      j += 1
    }
  }
  while (i < a.length) {
    lines.push({ kind: "remove", text: a[i] ?? "", left: i + 1 })
    i += 1
  }
  while (j < b.length) {
    lines.push({ kind: "add", text: b[j] ?? "", right: j + 1 })
    j += 1
  }
  return lines
}

export function diffSummary(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  }
}
