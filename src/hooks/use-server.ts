import { useEffect, useRef } from 'react'

const RESTART_DELAY = 2000

export function useServer() {
  const childRef = useRef<unknown>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    // Only spawn in Tauri — in browser, the user or Claude Code manages the server
    if (!('__TAURI__' in window)) return

    let killed = false

    async function spawn() {
      try {
        const { Command } = await import('@tauri-apps/plugin-shell')

        // Resolve the absolute path to the server script.
        // In dev, Tauri CWD is the project root. In prod, use the resource dir.
        let scriptPath: string
        try {
          const { resourceDir } = await import('@tauri-apps/api/path')
          const base = await resourceDir()
          scriptPath = base + 'mcp-server/dist/index.js'
        } catch {
          // Dev fallback: relative to project root (Tauri CWD in dev mode)
          scriptPath = 'mcp-server/dist/index.js'
        }

        console.log('[useServer] spawning: node', scriptPath, '--http-only')

        // "taskflow-server" matches the name in capabilities/default.json scope
        const command = Command.create('taskflow-server', [scriptPath, '--http-only'])

        command.on('close', (data) => {
          console.log(`[useServer] server exited with code ${data.code}`)
          childRef.current = null
          if (!killed && mountedRef.current) {
            console.log(`[useServer] restarting in ${RESTART_DELAY}ms...`)
            setTimeout(spawn, RESTART_DELAY)
          }
        })

        command.on('error', (err) => {
          console.error('[useServer] spawn error:', err)
        })

        command.stdout.on('data', (line) => {
          console.log('[useServer:stdout]', line)
        })

        command.stderr.on('data', (line) => {
          console.warn('[useServer:stderr]', line)
        })

        const child = await command.spawn()
        childRef.current = child
        console.log('[useServer] HTTP server started (pid:', child.pid, ')')
      } catch (err) {
        console.error('[useServer] failed to spawn server:', err)
        if (!killed && mountedRef.current) {
          setTimeout(spawn, RESTART_DELAY)
        }
      }
    }

    spawn()

    return () => {
      killed = true
      mountedRef.current = false
      if (childRef.current) {
        console.log('[useServer] killing server process')
        ;(childRef.current as { kill: () => void }).kill()
        childRef.current = null
      }
    }
  }, [])
}
