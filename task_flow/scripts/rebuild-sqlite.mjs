/**
 * Rebuilds the better-sqlite3 native addon inside the pnpm store.
 *
 * pnpm doesn't auto-compile native addons for transitive dependencies
 * (e.g. better-sqlite3 pulled in by @dalmasonto/taskflow-mcp).
 * This script finds the better-sqlite3 directory in node_modules/.pnpm
 * and runs node-gyp rebuild if the .node binary is missing.
 */
import { execSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')

// Skip if not using pnpm (no .pnpm directory)
if (!existsSync(pnpmDir)) {
  console.log('[rebuild-sqlite] not a pnpm project — skipping')
  process.exit(0)
}

// Find better-sqlite3@* in the pnpm store
const match = readdirSync(pnpmDir).find(d => d.startsWith('better-sqlite3@'))
if (!match) {
  console.log('[rebuild-sqlite] better-sqlite3 not found in pnpm store — skipping')
  process.exit(0)
}

const sqliteDir = join(pnpmDir, match, 'node_modules', 'better-sqlite3')
const binding = join(sqliteDir, 'build', 'Release', 'better_sqlite3.node')

if (existsSync(binding)) {
  console.log('[rebuild-sqlite] native binding already exists — skipping')
  process.exit(0)
}

console.log('[rebuild-sqlite] building better-sqlite3 native addon...')
try {
  execSync('npx --yes node-gyp rebuild', {
    cwd: sqliteDir,
    stdio: 'inherit',
  })
  console.log('[rebuild-sqlite] done')
} catch (err) {
  console.error('[rebuild-sqlite] failed — the Tauri app may not be able to spawn the MCP server')
  console.error('[rebuild-sqlite] manual fix: cd', sqliteDir, '&& npx node-gyp rebuild')
  process.exit(0) // Don't fail the install
}
