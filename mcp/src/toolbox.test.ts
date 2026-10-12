import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  diffLines,
  ensureGitignored,
  installScript,
  installedStatus,
  readManifest,
  sha256Hex,
  uninstallScript,
  type InstallableEntry,
} from "./toolbox"

let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "toolbox-test-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const entry = (overrides: Partial<InstallableEntry> = {}): InstallableEntry => ({
  name: "prod-report",
  version: 3,
  title: "Production report",
  description: "Use when asked for a production health report.",
  body_markdown: "Reads df and the last boot errors.",
  code: "#!/usr/bin/env bash\necho hi\n",
  language: "bash",
  entrypoint: "report.sh",
  params: [{ name: "since", description: "journalctl window", required: false }],
  requires_env: ["SERVER_HOST"],
  author_label: "Builder",
  ...overrides,
})

describe("installScript", () => {
  it("writes the script, a README, and the manifest entry, and ignores the folder", async () => {
    const result = await installScript({
      projectRoot: root,
      entry: entry(),
      vettedBy: "agent-7",
      vettedNote: "read-only: df + journalctl, prints a report, no deletes",
      env: { SERVER_HOST: "host" },
    })

    expect(result.run_command).toBe("./.taskflow/scripts/prod-report/report.sh")
    const script = await readFile(join(root, ".taskflow/scripts/prod-report/report.sh"), "utf8")
    expect(script).toBe(entry().code)

    const readme = await readFile(join(root, ".taskflow/scripts/prod-report/README.md"), "utf8")
    expect(readme).toContain("# Production report")
    expect(readme).toContain("./.taskflow/scripts/prod-report/report.sh")
    expect(readme).toContain("`SERVER_HOST`")

    const manifest = await readManifest(root)
    expect(manifest.scripts["prod-report"]).toMatchObject({
      version: 3,
      sha256: sha256Hex(entry().code),
      vetted_by: "agent-7",
      vetted_note: "read-only: df + journalctl, prints a report, no deletes",
      author: "Builder",
    })

    // The folder is kept out of git, once.
    expect(result.gitignore_updated).toBe(true)
    const gitignore = await readFile(join(root, ".gitignore"), "utf8")
    expect(gitignore.split("\n")).toContain(".taskflow/scripts/")
    expect(await ensureGitignored(root)).toBe(false)
  })

  it("reports the required environment variables that are missing here", async () => {
    const result = await installScript({
      projectRoot: root,
      entry: entry({ requires_env: ["SERVER_HOST", "USER_AT_HOST"] }),
      vettedBy: "agent-7",
      vettedNote: "read it",
      env: { SERVER_HOST: "host" },
    })
    expect(result.missing_env).toEqual(["USER_AT_HOST"])
  })

  it("refuses nothing here — vetting is the caller's gate; this is only the mechanism", async () => {
    // Reinstalling the same name at a newer version replaces it.
    await installScript({ projectRoot: root, entry: entry(), vettedBy: "a", vettedNote: "n", env: {} })
    await installScript({
      projectRoot: root,
      entry: entry({ version: 4, code: "#!/usr/bin/env bash\necho v4\n" }),
      vettedBy: "a",
      vettedNote: "n",
      env: {},
    })
    const manifest = await readManifest(root)
    expect(manifest.scripts["prod-report"].version).toBe(4)
    expect(manifest.scripts["prod-report"].sha256).toBe(sha256Hex("#!/usr/bin/env bash\necho v4\n"))
  })
})

describe("uninstallScript", () => {
  it("removes the folder and the manifest row", async () => {
    await installScript({ projectRoot: root, entry: entry(), vettedBy: "a", vettedNote: "n", env: {} })
    const result = await uninstallScript({ projectRoot: root, name: "prod-report" })
    expect(result.removed).toBe(true)
    const manifest = await readManifest(root)
    expect(manifest.scripts["prod-report"]).toBeUndefined()
    await expect(readFile(join(root, ".taskflow/scripts/prod-report/report.sh"), "utf8")).rejects.toThrow()
  })
})

describe("installedStatus", () => {
  it("says what is current, what has an update, and what was edited locally", async () => {
    await installScript({ projectRoot: root, entry: entry(), vettedBy: "a", vettedNote: "n", env: {} })
    await installScript({
      projectRoot: root,
      entry: entry({ name: "cleanup", code: "echo cleanup\n" }),
      vettedBy: "a",
      vettedNote: "n",
      env: {},
    })
    // "cleanup" gets a local edit after install: the file no longer matches
    // what was written, which is what the checksum has to catch.
    await installScript({
      projectRoot: root,
      entry: entry({ name: "cleanup", language: "bash", entrypoint: "cleanup.sh", code: "echo cleanup\n" }),
      vettedBy: "a",
      vettedNote: "n",
      env: {},
    })
    await writeFile(join(root, ".taskflow/scripts/cleanup/cleanup.sh"), "echo locally fixed\n", "utf8")

    const statuses = await installedStatus({
      projectRoot: root,
      serverScripts: [
        { name: "prod-report", version: 3 },
        { name: "cleanup", version: 1 },
        { name: "brand-new", version: 1 },
      ],
    })
    const byName = Object.fromEntries(statuses.map((s) => [s.name, s]))
    expect(byName["prod-report"]).toMatchObject({ state: "current", installed_version: 3, server_version: 3 })
    expect(byName["cleanup"]).toMatchObject({ state: "locally-edited", local_edit: true })
    expect(byName["brand-new"]).toMatchObject({ state: "not-installed", installed_version: null })

    // A newer server version with no local edit is an update, not an install.
    const newer = await installedStatus({ projectRoot: root, serverScripts: [{ name: "prod-report", version: 5 }] })
    expect(newer[0]).toMatchObject({ state: "update-available", installed_version: 3, server_version: 5 })
  })
})

describe("diffLines", () => {
  it("marks only the changed lines", () => {
    const before = "#!/usr/bin/env bash\necho one\necho two\n"
    const after = "#!/usr/bin/env bash\necho one\necho TWO\necho three\n"
    const diff = diffLines(before, after)
    expect(diff).toContain("  #!/usr/bin/env bash")
    expect(diff).toContain("  echo one")
    expect(diff).toContain("- echo two")
    expect(diff).toContain("+ echo TWO")
    expect(diff).toContain("+ echo three")
  })

  it("is empty in content when nothing changed", () => {
    expect(diffLines("a\nb", "a\nb").every((line) => line.startsWith("  "))).toBe(true)
  })
})
