/**
 * #617: installing vetted toolbox scripts into the local checkout.
 *
 * TaskFlow never runs a script; what it can do is put a REVIEWED one where the
 * agent (or the human) can run it directly. That is this module:
 *
 *   <project_root>/.taskflow/scripts/<name>/
 *     <entrypoint>        the script itself
 *     README.md           what it does, its params, its requires_env
 *   <project_root>/.taskflow/scripts/manifest.json
 *     per script: name, version, sha256, author, installed_at, vetted_by,
 *     vetted_note
 *
 * The manifest is what makes an install auditable later: the sha256 catches a
 * file edited in place (which must be pushed as a new version or reinstalled,
 * never run silently), and `vetted_*` records who read which version before it
 * was allowed to run. The directory is git-ignored by default — TaskFlow is the
 * source of truth for shared scripts, and two copies drifting is worse than
 * none.
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface ManifestEntry {
  name: string
  version: number
  sha256: string
  author: string
  installed_at: string
  vetted_by: string
  vetted_note: string
}

export interface Manifest {
  version: 1
  scripts: Record<string, ManifestEntry>
}

export interface InstallableEntry {
  name: string
  version: number
  title: string
  description: string
  body_markdown: string
  code: string
  language: string | null
  entrypoint: string | null
  params: { name: string; description?: string; required?: boolean }[]
  requires_env: string[]
  author_label: string
}

export interface InstallResult {
  name: string
  version: number
  path: string
  /** The command a person or agent runs, relative to the project root. */
  run_command: string
  sha256: string
  /** Required environment variables that are NOT set in this environment. */
  missing_env: string[]
  gitignore_updated: boolean
}

export function scriptsRoot(projectRoot: string): string {
  return join(projectRoot, ".taskflow", "scripts")
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The entrypoint a script installs under. Defaults to the name, with a
 *  language-appropriate suffix so the file is runnable/recognisable. */
export function entrypointFor(entry: { name: string; entrypoint: string | null; language: string | null }): string {
  if (entry.entrypoint?.trim()) return entry.entrypoint.trim()
  const suffix =
    entry.language === "python" ? ".py" : entry.language === "node" ? ".mjs" : entry.language === "bash" ? ".sh" : ""
  return `${entry.name}${suffix}`
}

export async function readManifest(projectRoot: string): Promise<Manifest> {
  try {
    const raw = await readFile(join(scriptsRoot(projectRoot), "manifest.json"), "utf8")
    const parsed = JSON.parse(raw) as Manifest
    if (parsed && parsed.version === 1 && parsed.scripts) return parsed
  } catch {
    // No manifest yet (or one we cannot read): start clean. A corrupted
    // manifest must not block installing.
  }
  return { version: 1, scripts: {} }
}

/** Everything a human needs to run the script without reading it first. */
export function readmeFor(entry: InstallableEntry, runCommand: string): string {
  const lines = [
    `# ${entry.title}`,
    "",
    entry.description,
    "",
    `Installed by TaskFlow from the project toolbox: \`${entry.name}\` v${entry.version} (by ${entry.author_label}).`,
    "Reinstalling after a new version replaces this folder; local edits are detected by checksum, not merged.",
    "",
    "## Run",
    "",
    "```sh",
    runCommand,
    "```",
  ]
  if (entry.params.length) {
    lines.push("", "## Parameters", "")
    for (const param of entry.params) {
      const required = param.required ? " (required)" : ""
      lines.push(`- \`${param.name}\`${required}${param.description ? ` — ${param.description}` : ""}`)
    }
  }
  if (entry.requires_env.length) {
    lines.push("", "## Environment", "", "The script reads these from the machine it runs on. TaskFlow stores their NAMES, never their values:", "")
    for (const name of entry.requires_env) lines.push(`- \`${name}\``)
  }
  if (entry.body_markdown.trim()) lines.push("", "## Notes", "", entry.body_markdown.trim())
  lines.push("")
  return lines.join("\n")
}

/**
 * Install (or reinstall) one script. Returns the path, the run command and
 * which required variables are missing here — the agent tells its human about
 * those; the values are never read, stored or printed.
 */
export async function installScript(options: {
  projectRoot: string
  entry: InstallableEntry
  vettedBy: string
  vettedNote: string
  /** Injectable for tests; defaults to the real process environment. */
  env?: Record<string, string | undefined>
}): Promise<InstallResult> {
  const { projectRoot, entry, vettedBy, vettedNote } = options
  const env = options.env ?? process.env
  const root = scriptsRoot(projectRoot)
  const dir = join(root, entry.name)
  const file = entrypointFor(entry)
  const runCommand = `./.taskflow/scripts/${entry.name}/${file}`

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, file), entry.code, { encoding: "utf8", mode: 0o755 })
  await writeFile(join(dir, "README.md"), readmeFor(entry, runCommand), "utf8")

  const manifest = await readManifest(projectRoot)
  const sha256 = sha256Hex(entry.code)
  manifest.scripts[entry.name] = {
    name: entry.name,
    version: entry.version,
    sha256,
    author: entry.author_label,
    installed_at: new Date().toISOString(),
    vetted_by: vettedBy,
    vetted_note: vettedNote,
  }
  await mkdir(root, { recursive: true })
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")

  const gitignoreUpdated = await ensureGitignored(projectRoot)
  const missing_env = entry.requires_env.filter((name) => !env[name])
  return {
    name: entry.name,
    version: entry.version,
    path: join(dir, file),
    run_command: runCommand,
    sha256,
    missing_env,
    gitignore_updated: gitignoreUpdated,
  }
}

/** Remove an installed script (its folder and its manifest row). */
export async function uninstallScript(options: { projectRoot: string; name: string }): Promise<{ removed: boolean }> {
  const { projectRoot, name } = options
  const manifest = await readManifest(projectRoot)
  const existed = Boolean(manifest.scripts[name])
  delete manifest.scripts[name]
  await rm(join(scriptsRoot(projectRoot), name), { recursive: true, force: true })
  await writeFile(
    join(scriptsRoot(projectRoot), "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  ).catch(() => {})
  return { removed: existed }
}

/**
 * Add `.taskflow/scripts/` to the project's `.gitignore`, once. Returns whether
 * the file was changed.
 */
export async function ensureGitignored(projectRoot: string): Promise<boolean> {
  const path = join(projectRoot, ".gitignore")
  const line = ".taskflow/scripts/"
  let content = ""
  try {
    content = await readFile(path, "utf8")
  } catch {
    // No .gitignore yet: create one with the rule.
  }
  const lines = content.split("\n").map((l) => l.trim())
  if (lines.includes(line) || lines.includes("/.taskflow/scripts/") || lines.includes(".taskflow/scripts")) {
    return false
  }
  const next = content && !content.endsWith("\n") ? `${content}\n${line}\n` : `${content}${line}\n`
  await writeFile(path, next, "utf8")
  return true
}

export type InstalledState = "current" | "update-available" | "locally-edited" | "not-installed"

export interface InstalledStatus {
  name: string
  state: InstalledState
  installed_version: number | null
  server_version: number
  /** Set when the file on disk no longer matches what was installed. */
  local_edit: boolean
}

/**
 * Compare the manifest with the server's index: what is installed, what has a
 * newer version, and what was edited in place. The agent reports this at
 * connect — especially "update available", which is installed ONLY after the
 * agent re-vets the diff.
 */
export async function installedStatus(options: {
  projectRoot: string
  serverScripts: { name: string; version: number; code_sha256?: string }[]
}): Promise<InstalledStatus[]> {
  const { projectRoot, serverScripts } = options
  const manifest = await readManifest(projectRoot)
  const statuses: InstalledStatus[] = []
  for (const script of serverScripts) {
    const installed = manifest.scripts[script.name]
    if (!installed) {
      statuses.push({ name: script.name, state: "not-installed", installed_version: null, server_version: script.version, local_edit: false })
      continue
    }
    const localEdit = await installedFileEdited(projectRoot, script.name, installed.sha256)
    const state: InstalledState = localEdit
      ? "locally-edited"
      : installed.version < script.version
        ? "update-available"
        : "current"
    statuses.push({
      name: script.name,
      state,
      installed_version: installed.version,
      server_version: script.version,
      local_edit: localEdit,
    })
  }
  return statuses
}

/** Was the installed file changed on disk since it was written? */
export async function installedFileEdited(
  projectRoot: string,
  name: string,
  expectedSha: string,
): Promise<boolean> {
  try {
    const dir = join(scriptsRoot(projectRoot), name)
    // The manifest does not name the entrypoint's file; the folder holds the
    // script plus README.md, so hash the one file that is neither.
    const { readdir } = await import("node:fs/promises")
    const files = await readdir(dir)
    const [script] = files.filter((f) => f !== "README.md" && f !== "manifest.json")
    if (!script) return true
    const content = await readFile(join(dir, script), "utf8")
    return sha256Hex(content) !== expectedSha
  } catch {
    return false
  }
}

/**
 * A compact line diff — enough to re-vet a script that changed, without
 * pulling a diff library into the MCP. Plain LCS over lines.
 */
export function diffLines(from: string, to: string): string[] {
  const a = from.split("\n")
  const b = to.split("\n")
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = lcs[i]
      const next = lcs[i + 1]
      if (!row || !next) continue
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i] ?? ""
    const right = b[j] ?? ""
    if (left === right) {
      lines.push(`  ${left}`)
      i += 1
      j += 1
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push(`- ${left}`)
      i += 1
    } else {
      lines.push(`+ ${right}`)
      j += 1
    }
  }
  while (i < a.length) lines.push(`- ${a[i++] ?? ""}`)
  while (j < b.length) lines.push(`+ ${b[j++] ?? ""}`)
  return lines
}
