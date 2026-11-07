#!/usr/bin/env node
// One-off snapshot of the TaskFlow design project into docs/v3-design/, the
// visual reference v3 is rebuilt from (design doc: docs/superpowers/specs/
// 2026-11-08-v3-ui-upgrade-design.md). Reference only, never shipped.
//
// Re-run it when the design changes and commit the diff, so design changes show
// up in review.
//
// Usage: node scripts/snapshot-design.mjs [profile]
// Reads the server, project and agent key from .taskflow.json (default profile).

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const config = JSON.parse(await readFile(join(root, ".taskflow.json"), "utf8"))
const profile = config.profiles[process.argv[2] ?? config.default_profile]
if (!profile) throw new Error(`unknown profile ${process.argv[2]}`)

const base = `${config.server}/api/taskflow/agents/design`
const out = join(root, "docs", "v3-design")

async function get(path, query) {
  const url = new URL(`${base}/${path}`)
  for (const [k, v] of Object.entries({ project: config.project, ...query })) url.searchParams.set(k, String(v))
  // Agent keys use the `Agent` scheme, not Bearer.
  const res = await fetch(url, { headers: { Authorization: `Agent ${profile.key}` } })
  if (!res.ok) throw new Error(`${res.status} ${url.pathname}?${url.searchParams}: ${await res.text()}`)
  return res.json()
}

async function save(rel, text) {
  const file = join(out, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text.endsWith("\n") ? text : `${text}\n`)
}

const context = await get("context")
await save("tokens.css", context.tokens_css)
await save("tokens.json", JSON.stringify(context.tokens_json, null, 2))
await save("resources.json", JSON.stringify(context.resources?.doc ?? null, null, 2))
await save("themes.json", JSON.stringify(context.themes, null, 2))

const index = []
for (const route of context.routes) {
  const page = await get("page", { route: route.path })
  // Design routes are flat ("/board", "/board--empty"); "/" is the index page.
  await save(`pages/${route.file.replace(/^pages\//, "")}`, page.content)
  index.push({ route: route.path, title: route.title, file: route.file, version: page.version })
}

for (const component of context.components) {
  const c = await get("component", { name: component.name })
  await save(`components/${component.name}.js`, c.content)
  index.push({ component: component.name, attrs: component.attrs, usedOn: component.usedOn, version: c.version })
}

await save("index.json", JSON.stringify({ revision: context.revision, entries: index }, null, 2))
console.log(`snapshot: ${context.routes.length} pages, ${context.components.length} components → docs/v3-design/`)
